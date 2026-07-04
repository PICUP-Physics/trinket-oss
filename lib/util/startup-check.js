'use strict';

// Startup smoke test — runs before the HTTP server begins accepting traffic.
// Prints a clear summary of which backends are configured and whether they
// are reachable.  Any critical failure is returned so the caller can exit.

const config  = require('config');
const TIMEOUT = 5000; // ms to wait for each connectivity probe

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function probeFirestore(projectId) {
  const Firestore = require('@google-cloud/firestore');
  const opts = { ignoreUndefinedProperties: true };
  if (projectId) opts.projectId = projectId;
  const db = new Firestore(opts);
  await db.collection('_health').doc('startup').get();
}

async function probeMongo(host, port, database) {
  const mongoose = require('mongoose');
  const uri = `mongodb://${host}:${port}/${database}`;
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: TIMEOUT });
  await conn.asPromise();
  await conn.close();
}

async function run() {
  const dbBackend = (config.db && config.db.backend) || 'mongoose';
  const sessionBackend =
    (config.app.plugins.session.cache && config.app.plugins.session.cache.backend) ||
    dbBackend;

  const checks = [];
  let fatal = false;

  // ── DB backend ────────────────────────────────────────────────────────────
  if (dbBackend === 'firestore') {
    const emulator = process.env.FIRESTORE_EMULATOR_HOST || '(production)';
    const projectId = config.db.firestore && config.db.firestore.projectId;
    try {
      await withTimeout(probeFirestore(projectId), TIMEOUT, 'Firestore');
      checks.push(`  DB:      firestore  project=${projectId}  emulator=${emulator}  ✓`);
    } catch (err) {
      checks.push(`  DB:      firestore  project=${projectId}  emulator=${emulator}  ✗  ${err.message}`);
      fatal = true;
    }
  } else {
    const host = config.db.mongo && config.db.mongo.host;
    const port = config.db.mongo && config.db.mongo.port;
    const db   = config.db.mongo && config.db.mongo.database;
    try {
      await withTimeout(probeMongo(host, port, db), TIMEOUT, 'MongoDB');
      checks.push(`  DB:      mongoose   ${host}:${port}/${db}  ✓`);
    } catch (err) {
      checks.push(`  DB:      mongoose   ${host}:${port}/${db}  ✗  ${err.message}`);
      fatal = true;
    }
  }

  // ── Session cache ─────────────────────────────────────────────────────────
  if (sessionBackend === 'memory') {
    checks.push(`  Session: memory     (in-process, not persistent)  ✓`);
  } else if (sessionBackend === 'firestore') {
    // Already probed above if db backend is also firestore; skip a second round-trip.
    if (dbBackend !== 'firestore') {
      const projectId = config.db.firestore && config.db.firestore.projectId;
      try {
        await withTimeout(probeFirestore(projectId), TIMEOUT, 'Firestore (session)');
        checks.push(`  Session: firestore  ✓`);
      } catch (err) {
        checks.push(`  Session: firestore  ✗  ${err.message}`);
        fatal = true;
      }
    } else {
      checks.push(`  Session: firestore  (same connection as DB)  ✓`);
    }
  } else {
    checks.push(`  Session: mongoose   (same connection as DB)`);
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  const width = 60;
  console.log('\n' + '─'.repeat(width));
  console.log('  STARTUP CHECK');
  console.log('─'.repeat(width));
  checks.forEach(l => console.log(l));
  console.log('─'.repeat(width) + '\n');

  return !fatal;
}

module.exports = { run };
