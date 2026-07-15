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

// Supported deployment shapes are ALL-OR-NONE (design decision 3, see
// docs/GCR-PICUP-TRIAL-MERGE-NOTES.md): choosing GCP means firestore AND
// Firebase Auth together; self-host means mongoose AND local auth. The
// crossed combinations are unsupported — firestore+local in particular is
// the shape where backend-semantics bugs (isModified/save-hook misses)
// corrupt data silently. Unsupported shapes refuse to start in production
// unless app.allowUnsupportedConfig is set; everywhere else they warn.
// Pure function (cfg + env in, verdict out) so tests can cover the matrix
// without booting or mutating the real config.
function checkShape(cfg, env) {
  const db   = (cfg.db   && cfg.db.backend)    || 'mongoose';
  const auth = (cfg.auth && cfg.auth.provider) || 'local';
  const allow = !!(cfg.app && cfg.app.allowUnsupportedConfig);

  const supported =
    (db === 'firestore') === (auth === 'firebase'); // both GCP or neither

  if (supported) {
    return { level: 'ok', lines: [] };
  }

  const level = (env === 'production' && !allow) ? 'fatal' : 'warn';
  const lines = [
    `  UNSUPPORTED CONFIG SHAPE: db.backend=${db} + auth.provider=${auth}`,
    `  Supported shapes are all-or-none:`,
    `    self-host:  db.backend: mongoose   + auth.provider: local`,
    `    GCP:        db.backend: firestore  + auth.provider: firebase`,
    level === 'fatal'
      ? `  Refusing to start in production. To proceed anyway (unsupported,`
      : `  Continuing (non-production). In production this refuses to start`,
    level === 'fatal'
      ? `  at your own risk), set app.allowUnsupportedConfig: true.`
      : `  unless app.allowUnsupportedConfig: true is set.`
  ];
  return { level: level, lines: lines };
}

async function run() {
  const dbBackend = (config.db && config.db.backend) || 'mongoose';
  const sessionBackend =
    (config.app.plugins.session.cache && config.app.plugins.session.cache.backend) ||
    dbBackend;

  const checks = [];
  let fatal = false;

  // ── Supported-shape gate (all-or-none) ────────────────────────────────────
  const shape = checkShape(config, process.env.NODE_ENV);
  if (shape.level !== 'ok') {
    shape.lines.forEach(l => checks.push(l));
    if (shape.level === 'fatal') fatal = true;
  }

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

module.exports = { run, checkShape };
