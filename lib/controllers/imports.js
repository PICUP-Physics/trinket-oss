var Boom     = require('@hapi/boom');
var JSZip    = require('jszip');
var config   = require('config');
var Trinket  = require('../models/trinket');
var Course   = require('../models/course');
var Lesson   = require('../models/lesson');
var Material = require('../models/material');

// Files inside a trinket folder that are not code
var NON_CODE_RE = /^(metadata\.json)$|^assets\//;

// Matches <iframe src="https://trinket.io/embed/{lang}/{shortCode}...">
var TRINKET_EMBED_RE = /(<iframe[^>]+src=['"]https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})[^'"]*['"][^>]*>)/gi;

// ─── Trinket import ──────────────────────────────────────────────────────────

function importTrinkets(request, reply) {
  var zipBuffer = request.payload.file;
  var userId    = request.user && request.user.id;

  JSZip.loadAsync(zipBuffer)
    .then(function(zip) {
      var manifestFile = zip.file('manifest.json');
      if (!manifestFile) throw Boom.badRequest('zip does not contain manifest.json');

      return manifestFile.async('string').then(function(str) {
        var manifest;
        try { manifest = JSON.parse(str); } catch(e) { throw Boom.badRequest('manifest.json is not valid JSON'); }
        if (!Array.isArray(manifest.trinkets)) throw Boom.badRequest('manifest.json missing trinkets array');
        return { zip: zip, manifest: manifest };
      });
    })
    .then(function(ctx) {
      var results = { imported: 0, skipped: 0, failed: 0, mapping: {} };
      return ctx.manifest.trinkets.reduce(function(chain, entry) {
        return chain.then(function() {
          return importOneTrinket(ctx.zip, entry, userId, results);
        });
      }, Promise.resolve()).then(function() { return results; });
    })
    .then(function(results) {
      // Patch any course materials that were waiting on these trinkets
      var patchTargets = Object.keys(results.mapping);
      return patchUnresolvedRefs(patchTargets, results.mapping).then(function(patched) {
        results.patched = patched;
        return request.success({ data: results });
      });
    })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      return request.fail({ error: err.message });
    });
}

function importOneTrinket(zip, entry, userId, results) {
  var legacyShortCode = entry.shortCode;
  if (!legacyShortCode) return Promise.resolve();

  return Trinket.findOne({ legacyShortCode: legacyShortCode }).exec()
    .then(function(existing) {
      if (existing) {
        results.skipped++;
        results.mapping[legacyShortCode] = existing.shortCode;
        return;
      }

      return readTrinketFromZip(zip, entry)
        .then(function(data) {
          if (!data) { results.failed++; return; }

          var trinket = new Trinket({
            name            : data.name,
            lang            : data.lang,
            code            : data.code,
            settings        : data.settings,
            legacyShortCode : legacyShortCode,
            _owner          : userId,
            _creator        : userId
          });

          return trinket.save().then(function(saved) {
            results.imported++;
            results.mapping[legacyShortCode] = saved.shortCode;
          });
        })
        .catch(function(err) {
          console.error('Failed to import trinket', legacyShortCode, err.message);
          results.failed++;
        });
    });
}

function readTrinketFromZip(zip, entry) {
  var shortCode  = entry.shortCode;
  var folderPath = null;

  // Find the folder named {anything}_{shortCode}/ in the zip
  zip.forEach(function(relativePath, zipEntry) {
    if (folderPath) return;
    if (!zipEntry.dir) return;
    var dirName = relativePath.replace(/\/$/, '').split('/').pop();
    if (dirName.slice(-shortCode.length) === shortCode) {
      folderPath = relativePath; // already ends with /
    }
  });

  if (!folderPath) {
    console.warn('No folder found for legacy shortCode:', shortCode);
    return Promise.resolve(null);
  }

  var metaFile = zip.file(folderPath + 'metadata.json');
  if (!metaFile) {
    console.warn('No metadata.json at', folderPath);
    return Promise.resolve(null);
  }

  return metaFile.async('string').then(function(metaStr) {
    var meta;
    try { meta = JSON.parse(metaStr); } catch(e) { return null; }

    var codeFiles    = [];
    var codePromises = [];

    zip.forEach(function(relativePath, zipEntry) {
      if (zipEntry.dir) return;
      if (relativePath.indexOf(folderPath) !== 0) return;
      var localName = relativePath.slice(folderPath.length);
      if (!localName || NON_CODE_RE.test(localName)) return;
      codePromises.push(
        zipEntry.async('string').then(function(content) {
          codeFiles.push({ name: localName, content: content });
        })
      );
    });

    return Promise.all(codePromises).then(function() {
      return {
        name     : meta.name,
        lang     : meta.lang || entry.lang,
        code     : codeFiles.length === 1 ? codeFiles[0].content : JSON.stringify(codeFiles),
        settings : meta.settings
      };
    });
  });
}

// ─── Patch unresolved refs ───────────────────────────────────────────────────

// After trinkets are imported, find materials that had those legacyShortCodes
// in unresolvedLegacyRefs and rewrite the embed URLs to point to the local server.
function patchUnresolvedRefs(shortCodes, legacyMap) {
  if (!shortCodes.length) return Promise.resolve(0);
  var baseUrl = config.url;

  return Material.find({ unresolvedLegacyRefs: { $in: shortCodes } }).exec()
    .then(function(materials) {
      if (!materials.length) return 0;

      return Promise.all(materials.map(function(material) {
        var originalContent = material.content;
        material.content = (material.content || '').replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
          if (legacyMap[sc]) {
            return iframeTag.replace(
              /https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})/,
              baseUrl + '/embed/' + lang + '/' + legacyMap[sc]
            );
          }
          return full;
        });

        // Remove resolved codes from unresolvedLegacyRefs
        material.unresolvedLegacyRefs = (material.unresolvedLegacyRefs || []).filter(function(sc) {
          return !legacyMap[sc];
        });

        if (material.content === originalContent) return Promise.resolve();
        return material.save();
      })).then(function() { return materials.length; });
    });
}

// ─── Course import ───────────────────────────────────────────────────────────

function importCourse(request, reply) {
  var zipBuffer = request.payload.file;
  var force     = request.payload.force || false;
  var courseName = request.payload.name;
  var userId    = request.user && request.user.id;
  var user      = request.user;

  JSZip.loadAsync(zipBuffer)
    .then(function(zip) {
      return parseCourseZip(zip);
    })
    .then(function(chapters) {
      // Validate all trinket refs against legacyShortCode in DB
      return resolveAllRefs(chapters);
    })
    .then(function(result) {
      var chapters  = result.chapters;
      var missing   = result.missing;

      if (missing.length && !force) {
        // Return warning so the caller can decide to force or cancel
        return request.success({
          data: {
            status  : 'missing_refs',
            missing : missing,
            message : missing.length + ' trinket(s) not yet imported. Import trinkets first, or re-submit with force=true to leave old URLs intact.'
          }
        });
      }

      // Create the course structure
      return createCourseFromChapters(chapters, courseName, user)
        .then(function(course) {
          return request.success({ data: {
            status    : 'ok',
            courseId  : course.id,
            slug      : course.slug,
            ownerSlug : user.username,
            url       : '/' + user.username + '/courses/' + course.slug
          }});
        });
    })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      console.error('Course import error:', err);
      return request.fail({ error: err.message });
    });
}

function parseCourseZip(zip) {
  // Collect chapters: { chapterNum, folderName, materials: [{filename, content}] }
  var chapterMap = {};

  var promises = [];
  zip.forEach(function(relativePath, zipEntry) {
    if (zipEntry.dir) return;
    var match = relativePath.match(/^(chapter-(\d+))\/(.+\.md)$/i);
    if (!match) return;

    var folderName   = match[1];
    var chapterNum   = parseInt(match[2], 10);
    var filename     = match[3];

    if (!chapterMap[folderName]) {
      chapterMap[folderName] = { chapterNum: chapterNum, folderName: folderName, materials: [] };
    }

    var chapter = chapterMap[folderName];
    promises.push(
      zipEntry.async('string').then(function(content) {
        chapter.materials.push({ filename: filename, content: content });
      })
    );
  });

  return Promise.all(promises).then(function() {
    // Sort chapters by number, materials by filename within each chapter
    var chapters = Object.values(chapterMap).sort(function(a, b) {
      return a.chapterNum - b.chapterNum;
    });
    chapters.forEach(function(ch) {
      ch.materials.sort(function(a, b) {
        return a.filename < b.filename ? -1 : 1;
      });
    });
    return chapters;
  });
}

function resolveAllRefs(chapters) {
  // Find all unique legacy shortCodes referenced in all materials
  var allShortCodes = [];
  chapters.forEach(function(ch) {
    ch.materials.forEach(function(mat) {
      var match;
      TRINKET_EMBED_RE.lastIndex = 0;
      while ((match = TRINKET_EMBED_RE.exec(mat.content)) !== null) {
        var sc = match[3];
        if (allShortCodes.indexOf(sc) < 0) allShortCodes.push(sc);
      }
    });
  });

  if (!allShortCodes.length) {
    return Promise.resolve({ chapters: chapters, missing: [] });
  }

  // Look up all shortCodes in DB at once
  return Trinket.find({ legacyShortCode: { $in: allShortCodes } }).exec()
    .then(function(trinkets) {
      var legacyMap = {};
      trinkets.forEach(function(t) {
        legacyMap[t.legacyShortCode] = t.shortCode;
      });

      var missing = allShortCodes.filter(function(sc) { return !legacyMap[sc]; });

      // Rewrite content with resolved refs
      var baseUrl = config.url;
      chapters.forEach(function(ch) {
        ch.materials.forEach(function(mat) {
          mat.unresolvedLegacyRefs = [];
          mat.content = mat.content.replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
            if (legacyMap[sc]) {
              // Replace only the shortCode portion of the src URL
              return iframeTag.replace(
                /https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})/,
                baseUrl + '/embed/' + lang + '/' + legacyMap[sc]
              );
            } else {
              // Unresolved: keep original tag, track the old shortCode
              if (mat.unresolvedLegacyRefs.indexOf(sc) < 0) {
                mat.unresolvedLegacyRefs.push(sc);
              }
              return full;
            }
          });
        });
      });

      return { chapters: chapters, missing: missing };
    });
}

function createCourseFromChapters(chapters, courseName, user) {
  var course = new Course({
    name      : courseName || 'Imported Course',
    _owner    : user.id,
    ownerSlug : user.username
  });
  course.setOwner(user);

  return course.save()
    .then(function(savedCourse) {
      return course.addUser(user, ['course-owner'])
        .then(function() { return savedCourse; });
    })
    .then(function(savedCourse) {
      // Create lessons sequentially to preserve chapter order
      return chapters.reduce(function(chain, chapter) {
        return chain.then(function(c) {
          return createLessonFromChapter(c, chapter, user);
        });
      }, Promise.resolve(savedCourse));
    });
}

function createLessonFromChapter(course, chapter, user) {
  var lessonName = 'Chapter ' + chapter.chapterNum;
  var lesson = new Lesson({ name: lessonName });
  lesson.setOwner(user);

  return lesson.save()
    .then(function(savedLesson) {
      // Add materials sequentially to preserve order
      return chapter.materials.reduce(function(chain, mat) {
        return chain.then(function() {
          return createMaterialFromFile(savedLesson, mat, user);
        });
      }, Promise.resolve())
      .then(function() {
        course.lessons.push(savedLesson.id);
        return course.save();
      });
    });
}

function createMaterialFromFile(lesson, matFile, user) {
  var name = matFile.filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  var material = new Material({
    name    : name,
    content : matFile.content,
    type    : 'page',
    _owner  : user.id,
    unresolvedLegacyRefs : matFile.unresolvedLegacyRefs || []
  });
  material.setOwner(user);

  return material.save().then(function(savedMaterial) {
    lesson.materials.push(savedMaterial.id);
    return lesson.save();
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  importTrinkets : importTrinkets,
  importCourse   : importCourse
};
