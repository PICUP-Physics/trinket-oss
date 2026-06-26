#!/usr/bin/env node
/**
 * Enqueue a bulk-export job for a user, bypassing the HTTP endpoint.
 *
 * `POST /api/exports` currently crashes in Hapi's response marshal (an
 * unrelated pre-existing bug), so triggering an export from the UI fails even
 * though the job would queue. This helper creates the Export record and
 * enqueues the job directly, so the worker (see scripts/export-worker.js) can
 * build the archive. Useful for verifying export changes locally.
 *
 * Usage: node scripts/trigger-export.js <email|username>
 */

var mongoose = require('mongoose');

var who = process.argv[2];
if (!who) {
  console.error('Usage: node scripts/trigger-export.js <email|username>');
  process.exit(1);
}

require('../config/db');
var User = require('../lib/models/user');
var Export = require('../lib/models/export');
var exportsQueue = require('../lib/util/queues').exports();

function trigger() {
  // findByLogin matches email or username
  User.findByLogin(String(who).toLowerCase(), function (err, user) {
    if (err) { console.error('Database error:', err.message); process.exit(1); }
    if (!user) { console.error('User not found:', who); process.exit(1); }

    var record = new Export({ _owner: user.id, status: 'pending' });
    record.save()
      .then(function (saved) {
        exportsQueue.add({
          action: 'bulk-export',
          exportId: saved._id.toString(),
          userId: user.id.toString()
        });
        console.log('Queued bulk-export', saved._id.toString(), 'for', user.username || user.email);
        // Give Bull a moment to flush the job to redis before exiting.
        setTimeout(function () { process.exit(0); }, 2000);
      })
      .catch(function (err) { console.error('Failed to queue export:', err.message); process.exit(1); });
  });
}

if (mongoose.connection.readyState === 1) trigger();
else mongoose.connection.once('open', trigger);

mongoose.connection.on('error', function (err) {
  console.error('MongoDB connection error:', err.message);
  process.exit(1);
});
