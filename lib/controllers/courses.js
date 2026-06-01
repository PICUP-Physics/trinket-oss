var _           = require('underscore'),
    parseUrl    = require('url').parse,
    diff        = require('diff'),
    Hapi        = require('@hapi/hapi'),
    util        = require('util'),
    fs          = require('fs'),
    mkdirp      = require('mkdirp'),
    rimraf      = require('rimraf'),
    zip         = require('adm-zip'),
    config      = require('config'),
    StringUtils = require('../util/stringUtils'),
    nunjucks    = require('../util/nunjucks'),
    parser      = require('../shared/trinket-markdown.js')({}),
    errors      = require('@hapi/boom'),
    ObjectUtils = require('../util/objectUtils'),
    File        = require('../models/file'),
    FileUtil    = require('../util/file');

// Matches /api/files/{id}/{filename} in markdown image/src references.
// Group 1 = full path, group 2 = MongoDB id, group 3 = filename.
var ASSET_ID_RE = /(?:\]\(|src=['"]?)(\/api\/files\/([^\/\s)"'>]+)\/([^\s)"'>]+))/g;

function pad2(n) { return n < 10 ? '0' + n : String(n); }

module.exports = {
  creationForm : function(request, reply) {
    request.success();
  },

  create : async function(request, reply) {
    try {
      var response = await request.server.inject({
        url     : '/api/courses',
        method  : 'post',
        headers : {
          'content-type' : 'application/json',
          'accept'       : 'application/json'
        },
        payload : request.payload,
        auth    : {
          strategy    : 'session',
          credentials : request.auth.credentials
        }
      });

      if (response.result) {
        if (response.result.course) {
          request.success({
            course : response.result.course
          });
        }
        else if (response.result.err) {
          request.fail({
              err     : response.result.err
            , message : response.result.message
          });
        }
      }
    } catch (err) {
      request.fail({ err: err, message: err.message });
    }
  },

  getCourses : function(request, reply) {
    var roles;

    return request.user.getCourses()
      .then(function(courses) {
        return request.success({ data : courses });
      });
  },

  featuredCourses : function(request, reply) {
    return Course.findFeaturedForUser(request.user)
      .then(function(courses) {
        courses = _.map(courses, function(course) {
          page        = course.page;
          course      = ObjectUtils.serialize(course);
          course.page = page || "";

          return course;
        });
        return request.success({ data : courses });
      })
      .catch(function(error) {
        return request.success({ data : [] });
      });
  },

  copy : function(request, reply) {
    request.pre.course.copy(request.user, function(err, course) {
      var urlTemplate = (config.app.usersubdomains)
        ? '//{user}.{domain}/{course}'
        : '//{domain}/u/{user}/classes/{course}';

      var domain = config.app.url.hostname + (config.app.url.port ? ':' + config.app.url.port : '');
      var url = StringUtils.interpolate(urlTemplate, {
        user:   request.user.username,
        domain: domain,
        course: course.slug
      });

      return request.user.grant("course-owner", "course", { id : course.id })
        .then(function() {
          request.success({ classPageUrl : url });
        });
    });
  },

  coursePage : function(request, reply) {
    var courseId    = request.pre.course.id
      , isOwner     = request.user && request.user.hasRole('course-owner', 'course', { id : courseId })
      , canEdit     = request.user && request.user.hasPermission('manage-course-content', 'course', { id : courseId })
      , isAssoc     = request.user && request.user.hasRole('course-associate', 'course', { id : courseId })
      , adminEmails = (function() {
          if (process.env.ADMIN_EMAILS) { try { return JSON.parse(process.env.ADMIN_EMAILS); } catch(e) {} }
          return (config.auth && config.auth.adminEmails) || [];
        })()
      , isAdmin     = request.user && adminEmails.indexOf(request.user.email.toLowerCase()) >= 0
      , urlTemplate, url, event;

    if (!(canEdit || isAssoc)) {
      urlTemplate = (config.app.usersubdomains)
        ? '//{user}.{domain}/{course}'
        : '//{domain}/u/{user}/classes/{course}';

      var domain = config.app.url.hostname + (config.app.url.port ? ':' + config.app.url.port : '');
      url = config.app.url.protocol + ':' + StringUtils.interpolate(urlTemplate, {
        user   : request.params.userSlug,
        domain : domain,
        course : request.params.courseSlug
      });

      return reply().redirect(url);
    }

    request.success({
      courseId   : courseId,
      courseSlug : request.params.courseSlug,
      userSlug   : request.params.userSlug,
      canEdit    : canEdit,
      isAssoc    : isAssoc,
      isAdmin    : isAdmin
    });

  },

  download : function(request, reply) {
    var owner  = request.pre.user
      , course = request.pre.course;

    if (request.user.hasRole("course-owner", "course", { id : course.id })
    ||  course.globalSettings.courseType === "public"
    ||  course.globalSettings.courseType === "open"
    ||  request.user.hasPermission("create-private-course")
    ||  request.user.hasPermission("make-course-copy", "course", { id : course.id })) {

      var format    = request.query.format;

      var mkdirpify = util.promisify(mkdirp);
      var writeFile = util.promisify(fs.writeFile);

      var ownerDir  = '/tmp/' + owner.username;
      var courseDir = ownerDir + '/' + course.slug;

      var fullCourse = {
        name        : course.name,
        description : course.description,
        lessons     : []
      };

      var mkLessonDirs = function() {
        return Promise.all(course.lessons.map(function(lesson, lessonIndex) {
          return Lesson.findById(lesson)
            .then(function(lesson) {
              var lessonDir = courseDir + '/' + pad2(lessonIndex) + '-' + lesson.slug;
              // Use a plain object so materials array won't cast values back to ObjectId
              fullCourse.lessons[ lessonIndex ] = {
                name      : lesson.name,
                slug      : lesson.slug,
                materials : new Array(lesson.materials.length)
              };
              return mkdirpify(lessonDir)
                .then(function() {
                  return lesson.materials.map(function(material, materialIndex) {
                    return {
                      writeTo       : lessonDir,
                      material      : material,
                      lessonIndex   : lessonIndex,
                      materialIndex : materialIndex
                    };
                  });
                });
            });
        }));
      }

      var getMaterialContent = function(materialInfo) {
        var flatList = _.flatten(materialInfo);
        return Promise.all(flatList.map(function(info) {
          return Material.findById(info.material)
            .then(function(material) {
              var content = material && material.content ? material.content : '';

              fullCourse.lessons[ info.lessonIndex ].materials[ info.materialIndex ] = material;

              if (!material) { return null; }

              return {
                writeTo       : info.writeTo + '/' + pad2(info.materialIndex) + '-' + material.slug + '.' + format,
                content       : content,
                lessonIndex   : info.lessonIndex,
                materialIndex : info.materialIndex
              }
            });
        }));
      }

      var parseMaterialContent = function(contentInfo) {
        var context;

        return Promise.all(contentInfo.map(function(info) {
          // nunjucks parse of format is html
          if (format === "html") {
            var currentMaterialIndex
              , slides = [];

            fullCourse.lessons.map(function(lesson, lessonIndex) {
              lesson.materials.map(function(material, materialIndex) {
                slides.push( pad2(lessonIndex) + '-' + lesson.slug + '/' + pad2(materialIndex) + '-' + material.slug );
                if (lessonIndex === info.lessonIndex && materialIndex === info.materialIndex) {
                  currentMaterialIndex = slides.length - 1;
                }
              });
            });

            context = {
              pageContent   : parser(info.content),
              course        : fullCourse,
              owner         : owner,
              config        : config,
              lessonIndex   : info.lessonIndex,
              materialIndex : info.materialIndex,
              progress      : ( currentMaterialIndex + 1 ) / slides.length,
              prevPageHref  : currentMaterialIndex ? slides[ currentMaterialIndex - 1 ] : undefined,
              nextPageHref  : currentMaterialIndex + 1 <= slides.length ? slides[ currentMaterialIndex + 1 ] : undefined
            };

            return nunjucks.render('courses/download/view.html', context)
              .then(function(content) {
                return {
                  writeTo : info.writeTo,
                  content : content
                };
              });
          }
          else {
            return Promise.resolve({
              writeTo : info.writeTo,
              content : info.content
            });
          }
        }));
      }

      var writeMaterialFiles = function(files) {
        var writes = files.map(function(file) {
          return writeFile(file.writeTo, file.content);
        });

        var manifest = {
          name        : fullCourse.name,
          description : fullCourse.description,
          lessons     : fullCourse.lessons.map(function(lesson, lessonIndex) {
            return {
              name      : lesson.name,
              slug      : lesson.slug,
              materials : (lesson.materials || []).map(function(material) {
                return { name: material.name, slug: material.slug };
              })
            };
          })
        };
        writes.push(writeFile(courseDir + '/course.json', JSON.stringify(manifest, null, 2)));

        return Promise.all(writes).then(function() { return files; });
      }

      // Downloads each /api/files/{id}/{filename} asset from S3 and writes it
      // into assets/{id}/{filename} inside the course temp dir so adm-zip picks
      // it up.  Best-effort: a missing or un-downloadable asset logs a warning
      // and is skipped rather than aborting the whole export.
      var embedAssets = function(files) {
        if (!config.features || !config.features.assets) return Promise.resolve();

        var assetMap = {};
        (files || []).filter(Boolean).forEach(function(file) {
          var re = new RegExp(ASSET_ID_RE.source, 'g');
          var match;
          while ((match = re.exec(file.content || '')) !== null) {
            if (!assetMap[match[2]]) assetMap[match[2]] = match[3];
          }
        });

        var ids = Object.keys(assetMap);
        if (!ids.length) return Promise.resolve();

        var assetsDir = courseDir + '/assets';
        return mkdirpify(assetsDir).then(function() {
          return Promise.all(ids.map(function(id) {
            var filename = assetMap[id];
            return File.findById(id)
              .then(function(fileRecord) {
                if (!fileRecord) {
                  console.warn('course export: no File record for id', id);
                  return;
                }
                // url = container.host + '/' + s3Key  →  s3Key is the last segment
                var s3Key = fileRecord.url.split('/').pop();
                return FileUtil.downloadMaterialFileAsBuffer(s3Key)
                  .then(function(buffer) {
                    var assetDir = assetsDir + '/' + id;
                    return mkdirpify(assetDir).then(function() {
                      return writeFile(assetDir + '/' + filename, buffer);
                    });
                  });
              })
              .catch(function(err) {
                console.warn('course export: could not embed asset', filename, err.message);
              });
          }));
        });
      }

      var zipCourse = function() {
        return Promise.resolve().then(function() {
          var zipFile = courseDir + '.zip';
          var courseZip = new zip();
          courseZip.addLocalFolder(courseDir);
          courseZip.writeZip(zipFile);
          return zipFile;
        });
      }

      var returnZip = function(zipFile) {
        fs.stat(zipFile, function(err, stats) {
          var stream = fs.createReadStream(zipFile);
          rimraf(ownerDir, function() {
            return reply(stream)
              .type('application/zip')
              .bytes(stats.size)
              .header('Content-Disposition', 'attachment; filename=' + course.slug + '.zip');
          });
        });
      }

      return mkdirpify(courseDir)
        .then(mkLessonDirs)
        .then(getMaterialContent)
        .then(parseMaterialContent)
        .then(writeMaterialFiles)
        .then(embedAssets)
        .then(zipCourse)
        .then(returnZip)
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  }
};
