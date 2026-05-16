var Boom    = require('@hapi/boom');
var JSZip   = require('jszip');
var Trinket = require('../models/trinket');

// Files inside a trinket folder that are not code
var NON_CODE_RE = /^(metadata\.json)$|^assets\//;

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
      return request.success({ data: results });
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
  var shortCode = entry.shortCode;
  var lang      = entry.lang || 'glowscript';
  var folderPath = null;

  // Find the folder named {anything}_{shortCode} anywhere in the zip
  // Export format: {lang}/{sanitizedName}_{shortCode}/
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

    var codeFiles = [];
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

function importCourse(request, reply) {
  return request.fail(Boom.notImplemented('course import not yet implemented'));
}

module.exports = {
  importTrinkets : importTrinkets,
  importCourse   : importCourse
};
