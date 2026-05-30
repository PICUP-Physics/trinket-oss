#!/usr/bin/env node
//
// scripts/fix-imported-file-urls.js
//
// Re-hosts /api/files/ image assets (from trinket.io) in already-imported course
// materials onto our own S3 bucket, then rewrites the content URLs.
//
// This is a one-off migration for materials imported before the fix in
// lib/controllers/imports.js that now handles this automatically on import.
//
// Usage (with the Firestore emulator):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   FIRESTORE_PROJECT_ID=demo-trinket \
//   node scripts/fix-imported-file-urls.js
//
// Against production (Google Cloud Firestore):
//   FIRESTORE_PROJECT_ID=your-project-id \
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//   node scripts/fix-imported-file-urls.js
//
// Pass --dry-run to preview which materials would change without writing.
// Pass --fallback-only to skip S3 and just rewrite to absolute trinket.io URLs
//   (useful if S3 is not configured yet).

'use strict';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

var projectId = process.env.FIRESTORE_PROJECT_ID || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

var crypto   = require('crypto');
var request  = require('request');
var config   = require('config');
var FileUtil = require('../lib/util/file');

User     = global.User     = require('../lib/models/user');
Course   = global.Course   = require('../lib/models/course');
Lesson   = global.Lesson   = require('../lib/models/lesson');
Material = global.Material = require('../lib/models/material');
Trinket  = global.Trinket  = require('../lib/models/trinket');
File     = global.File     = require('../lib/models/file');

var DRY_RUN       = process.argv.includes('--dry-run');
var FALLBACK_ONLY = process.argv.includes('--fallback-only') || !config.features.assets;

var SOURCE        = 'https://trinket.io';
var FILES_PATH_RE = /(?:\]\(|src=['"]?)(\/api\/files\/[^\s)"'>]+)/g;

// ─────────────────────────────────────────────────────────────────────────────

function collectPaths(content) {
  var paths = [], match, re = new RegExp(FILES_PATH_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    if (match[1] && !paths.includes(match[1])) paths.push(match[1]);
  }
  return paths;
}

function rehostAsset(relativePath) {
  var sourceUrl = SOURCE + relativePath;
  var filename  = relativePath.split('/').pop();
  var ext       = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  return new Promise(function(resolve) {
    request({ url: sourceUrl, encoding: null }, function(err, resp, body) {
      if (err || !body || resp.statusCode !== 200) {
        console.warn('  ! fetch failed:', sourceUrl, err || resp.statusCode);
        return resolve(sourceUrl); // fall back to absolute trinket.io URL
      }

      var hash        = crypto.createHash('sha1').update(body).digest('hex');
      var contentType = resp.headers['content-type'] || ('image/' + (ext || 'png'));
      var container   = config.aws.buckets.materials;
      var s3Key       = hash + (ext ? '.' + ext : '');

      FileUtil._upload(body, container, true, { name: s3Key, contentType: contentType }, function(uploadErr) {
        if (uploadErr) {
          console.warn('  ! upload failed:', filename, uploadErr.message);
          return resolve(sourceUrl);
        }

        var file = new File({
          url  : container.host + '/' + s3Key,
          type : 'embed',
          name : filename,
          mime : contentType,
          hash : hash,
          size : body.length
        });

        file.save().then(function(saved) {
          var base = filename.lastIndexOf('.') > -1 ? filename.slice(0, filename.lastIndexOf('.')) : filename;
          resolve('/api/files/' + saved.id + '/' + base + (ext ? '.' + ext : ''));
        }).catch(function(saveErr) {
          console.warn('  ! File save failed:', filename, saveErr.message);
          resolve(sourceUrl);
        });
      });
    });
  });
}

function rewriteContent(content) {
  // --fallback-only / no S3: just make URLs absolute
  if (FALLBACK_ONLY) {
    return Promise.resolve(
      content.replace(new RegExp(FILES_PATH_RE.source, 'g'), function(full, p) {
        return full.replace(p, SOURCE + p);
      })
    );
  }

  var paths = collectPaths(content);
  if (!paths.length) return Promise.resolve(content);

  return Promise.all(paths.map(function(p) {
    return rehostAsset(p).then(function(np) { return { old: p, new: np }; });
  })).then(function(replacements) {
    return replacements.reduce(function(c, r) { return c.split(r.old).join(r.new); }, content);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN)       console.log('DRY RUN — no writes will happen\n');
  if (FALLBACK_ONLY) console.log('FALLBACK MODE — rewriting to absolute trinket.io URLs (S3 not configured)\n');

  console.log('Fetching all materials…');
  var materials = await Material.find({}).exec();
  console.log('Total materials:', materials.length);

  var affected = materials.filter(function(m) {
    return m.content && m.content.includes('/api/files/');
  });
  console.log('Materials with /api/files/ references:', affected.length);
  if (!affected.length) { console.log('Nothing to do.'); return; }

  var fixed = 0, failed = 0;
  for (var i = 0; i < affected.length; i++) {
    var m = affected[i];
    console.log('\n[' + (i + 1) + '/' + affected.length + '] ' + m.name + ' (' + m.id + ')');

    var updated = await rewriteContent(m.content);
    if (updated === m.content) { console.log('  (no change)'); continue; }

    if (!DRY_RUN) {
      try {
        m.content = updated;
        await m.save();
        console.log('  saved');
        fixed++;
      } catch (e) {
        console.error('  save error:', e.message);
        failed++;
      }
    } else {
      console.log('  [dry] would update');
      fixed++;
    }
  }

  console.log('\nDone. Updated:', fixed, '  Failed:', failed);
}

main()
  .then(function() { process.exit(0); })
  .catch(function(err) {
    console.error('migration failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
