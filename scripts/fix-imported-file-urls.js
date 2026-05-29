#!/usr/bin/env node
//
// scripts/fix-imported-file-urls.js
//
// Rewrites relative /api/files/ image URLs in already-imported course materials
// to point back to https://trinket.io where they actually live.
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
// Pass --dry-run to preview changes without writing.

'use strict';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

var projectId = process.env.FIRESTORE_PROJECT_ID || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

User     = global.User     = require('../lib/models/user');
Course   = global.Course   = require('../lib/models/course');
Lesson   = global.Lesson   = require('../lib/models/lesson');
Material = global.Material = require('../lib/models/material');
Trinket  = global.Trinket  = require('../lib/models/trinket');

var DRY_RUN = process.argv.includes('--dry-run');

var FILES_RE     = /(\]\(|src=['"])(\/api\/files\/)/g;
var FILES_SOURCE = 'https://trinket.io';

function rewrite(content) {
  return content.replace(FILES_RE, function(_, prefix, path) {
    return prefix + FILES_SOURCE + path;
  });
}

async function main() {
  if (DRY_RUN) console.log('DRY RUN — no writes will happen\n');

  console.log('Fetching all materials…');
  var materials = await Material.find({}).exec();
  console.log('Total materials:', materials.length);

  var affected = materials.filter(function(m) {
    return m.content && m.content.includes('/api/files/');
  });
  console.log('Materials with /api/files/ references:', affected.length);

  if (!affected.length) {
    console.log('Nothing to do.');
    return;
  }

  var fixed = 0;
  for (var i = 0; i < affected.length; i++) {
    var m = affected[i];
    var original = m.content;
    var updated  = rewrite(original);
    if (updated === original) continue; // rewrite changed nothing (shouldn't happen, but safe)

    console.log('  ' + (DRY_RUN ? '[dry]' : '[fix]') + ' material ' + m.id + ' — ' + m.name);

    if (!DRY_RUN) {
      m.content = updated;
      await m.save();
    }
    fixed++;
  }

  console.log('\n' + (DRY_RUN ? 'Would fix' : 'Fixed') + ': ' + fixed + ' material(s)');
}

main()
  .then(function() { process.exit(0); })
  .catch(function(err) {
    console.error('migration failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
