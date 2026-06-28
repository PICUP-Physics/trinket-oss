// CommonJS so it can require() the CJS app/config. Runs once per test file.
// vitest cannot be require()'d in CJS; rely on Vitest globals (globals: true)
// for the lifecycle hooks and `inject`.
const mongoose = require('mongoose');

// Set NODE_ENV before ANY require('config') so node-config loads test.yaml and
// model.js exposes its config (Lesson.plugins etc.) under the 'test' env.
process.env.NODE_ENV = 'test';

beforeAll(async () => {
  // 1) Point config at the memory server BEFORE config/db (app.js) is required.
  //    config/db.js connects at require-time, so this must run first.
  // `inject` isn't a Vitest global; pull it via dynamic import (works in CJS).
  const { inject } = await import('vitest');
  const uri = inject('mongoUri');
  const u = new URL(uri);
  const config = require('config');
  config.db.mongo.host = u.hostname;
  config.db.mongo.port = u.port;
  // Give each test FILE its own unique database so parallel workers don't
  // clobber each other's data via afterEach dropDatabase().
  config.db.mongo.database = 'test_' + Math.random().toString(36).slice(2);

  // app.js exits(1) if the session cookie password is < 32 chars. Provide one.
  config.app.plugins.session.cookieOptions.password =
    'test-only-session-cookie-password-0123456789';

  // 2) Disable redis before app boot. config/redis.js and lib/util/queues.js
  //    read `config.db.redis.enabled !== false` at require-time: with it false,
  //    config/redis skips connecting and queues use the in-memory impl instead
  //    of bull. Without this, bull (node_redis v2) connects to localhost:6379
  //    and floods the run with uncaught ECONNREFUSED errors (non-zero exit).
  config.db.redis.enabled = false;

  // Also mock redis.createClient as a belt-and-braces measure for any code path
  // that still reaches for a client while redis is disabled.
  const redis = require('redis');
  const redismock = require('redis-mock');
  redis.createClient = redismock.createClient;

  // 3) Boot the app: registers model globals (Lesson, etc.) + connects via
  //    config/db. app.js exports the init() promise; await it so the globals
  //    (assigned inside init) are registered before tests run.
  await require('../../app.js');

  // 4) Wait for the mongoose connection to be ready.
  await mongoose.connection.asPromise();
});

afterEach(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db.dropDatabase();
  }
});

afterAll(async () => {
  await mongoose.disconnect();
});
