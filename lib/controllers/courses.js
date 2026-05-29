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
    ObjectUtils = require('../util/objectUtils');

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

      var url = StringUtils.interpolate(urlTemplate, {
        user:   request.user.username,
        domain: config.app.url.hostname,
        course: course.slug
      });

      return request.user.grant("course-owner", "course", { id : course.id })
        .then(function() {
          request.success({ classPageUrl : url });
        });
    });
  },

  coursePage : function(request, reply) {
    var courseId = request.pre.course.id
      , isOwner  = request.user && request.user.hasRole('course-owner', 'course', { id : courseId })
      , canEdit  = request.user && request.user.hasPermission('manage-course-content', 'course', { id : courseId })
      , isAssoc  = request.user && request.user.hasRole('course-associate', 'course', { id : courseId })
      , urlTemplate, url, event;

    if (!(canEdit || isAssoc)) {
      urlTemplate = (config.app.usersubdomains)
        ? '//{user}.{domain}/{course}'
        : '//{domain}/u/{user}/classes/{course}';

      url = config.app.url.protocol + ':' + StringUtils.interpolate(urlTemplate, {
        user   : request.params.userSlug,
        domain : config.app.url.hostname,
        course : request.params.courseSlug
      });

      return reply().redirect(url);
    }

    request.success({
      courseId   : courseId,
      courseSlug : request.params.courseSlug,
      userSlug   : request.params.userSlug,
      canEdit    : canEdit,
      isAssoc    : isAssoc
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
              var content = !material ? '' : material.content;

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
          // TODO, maybe eventually?
          // find any trinket assets in each material
          // create _assets folder if it doesn't exist
          // download asset to _assets folder
          // replace material reference with local reference

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

        return Promise.all(writes);
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
