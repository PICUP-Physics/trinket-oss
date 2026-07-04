// CommonJS so it can require() the CJS app/config. Runs once per test file.
// vitest cannot be require()'d in CJS; rely on Vitest globals (globals: true)
// for the lifecycle hooks and `inject`.
const mongoose = require('mongoose');

// An in-memory, redis-v4-compatible client. Backed by a per-client Map, so each
// test FILE (which gets its own setup run) starts with a fresh store. Implements
// the promise-based v4 surface that lib/util/store.js and the login rate-limiter
// (lib/controllers/users.js) actually exercise: connect/get/set/del/expire/incr/
// exists/keys, list ops (lPush/rPush/lRange/lRem/lIndex/lLen), set ops
// (sAdd/sRem/sMembers/sIsMember), hash ops (hGet/hSet/hGetAll/hDel), plus
// on/quit/multi for compatibility.
function makeInMemoryRedisClient() {
  const store = new Map(); // key -> string | string[] (list) | Set | Map (hash)
  const timers = new Map();

  const clearTimer = (key) => {
    if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
  };
  const asList = (key) => {
    let v = store.get(key);
    if (!Array.isArray(v)) { v = []; store.set(key, v); }
    return v;
  };
  const asSet = (key) => {
    let v = store.get(key);
    if (!(v instanceof Set)) { v = new Set(); store.set(key, v); }
    return v;
  };
  const asHash = (key) => {
    let v = store.get(key);
    if (!(v instanceof Map)) { v = new Map(); store.set(key, v); }
    return v;
  };

  const client = {
    isOpen: false,
    isReady: false,
    connect: async function () { this.isOpen = true; this.isReady = true; return this; },
    quit: async function () { this.isOpen = false; this.isReady = false; return 'OK'; },
    disconnect: async function () { this.isOpen = false; this.isReady = false; return undefined; },
    on: function () { return this; },
    off: function () { return this; },

    // strings
    get: async (key) => {
      const v = store.get(key);
      return v === undefined ? null : v;
    },
    set: async (key, val /*, opts */) => {
      clearTimer(key);
      store.set(key, String(val));
      return 'OK';
    },
    setEx: async (key, seconds, val) => {
      store.set(key, String(val));
      clearTimer(key);
      timers.set(key, setTimeout(() => { store.delete(key); timers.delete(key); }, seconds * 1000).unref());
      return 'OK';
    },
    del: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      let n = 0;
      keys.forEach((k) => { clearTimer(k); if (store.delete(k)) n++; });
      return n;
    },
    expire: async (key, seconds) => {
      if (!store.has(key)) return 0;
      clearTimer(key);
      timers.set(key, setTimeout(() => { store.delete(key); timers.delete(key); }, seconds * 1000).unref());
      return 1;
    },
    ttl: async (key) => (store.has(key) ? (timers.has(key) ? 1 : -1) : -2),
    incr: async (key) => {
      const n = parseInt(store.get(key) || '0', 10) + 1;
      store.set(key, String(n));
      return n;
    },
    decr: async (key) => {
      const n = parseInt(store.get(key) || '0', 10) - 1;
      store.set(key, String(n));
      return n;
    },
    exists: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      return keys.reduce((acc, k) => acc + (store.has(k) ? 1 : 0), 0);
    },
    keys: async (pattern) => {
      const all = Array.from(store.keys());
      if (!pattern || pattern === '*') return all;
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return all.filter((k) => re.test(k));
    },

    // lists
    lPush: async (key, value) => {
      const list = asList(key);
      const vals = Array.isArray(value) ? value : [value];
      vals.forEach((v) => list.unshift(String(v)));
      return list.length;
    },
    rPush: async (key, value) => {
      const list = asList(key);
      const vals = Array.isArray(value) ? value : [value];
      vals.forEach((v) => list.push(String(v)));
      return list.length;
    },
    lIndex: async (key, index) => {
      const list = store.get(key);
      if (!Array.isArray(list)) return null;
      const i = index < 0 ? list.length + index : index;
      return i in list ? list[i] : null;
    },
    lRange: async (key, start, stop) => {
      const list = store.get(key);
      if (!Array.isArray(list)) return [];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return list.slice(start < 0 ? list.length + start : start, end);
    },
    lRem: async (key, count, value) => {
      const list = store.get(key);
      if (!Array.isArray(list)) return 0;
      const target = String(value);
      let removed = 0;
      const next = list.filter((item) => {
        if (item === target && (count === 0 || removed < Math.abs(count))) { removed++; return false; }
        return true;
      });
      store.set(key, next);
      return removed;
    },
    lLen: async (key) => {
      const list = store.get(key);
      return Array.isArray(list) ? list.length : 0;
    },

    // sets
    sAdd: async (key, members) => {
      const set = asSet(key);
      const arr = Array.isArray(members) ? members : [members];
      let added = 0;
      arr.forEach((m) => { if (!set.has(String(m))) { set.add(String(m)); added++; } });
      return added;
    },
    sRem: async (key, member) => {
      const set = store.get(key);
      if (!(set instanceof Set)) return 0;
      return set.delete(String(member)) ? 1 : 0;
    },
    sMembers: async (key) => {
      const set = store.get(key);
      return set instanceof Set ? Array.from(set) : [];
    },
    sIsMember: async (key, member) => {
      const set = store.get(key);
      return set instanceof Set && set.has(String(member));
    },

    // hashes
    hSet: async (key, field, value) => {
      const hash = asHash(key);
      const existed = hash.has(field);
      hash.set(field, String(value));
      return existed ? 0 : 1;
    },
    hGet: async (key, field) => {
      const hash = store.get(key);
      return hash instanceof Map && hash.has(field) ? hash.get(field) : null;
    },
    hGetAll: async (key) => {
      const hash = store.get(key);
      if (!(hash instanceof Map)) return {};
      return Object.fromEntries(hash);
    },
    hDel: async (key, field) => {
      const hash = store.get(key);
      return hash instanceof Map && hash.delete(field) ? 1 : 0;
    },

    flushAll: async () => { store.clear(); timers.forEach((t) => clearTimeout(t)); timers.clear(); return 'OK'; },
  };

  // multi/exec: queue calls and run them sequentially.
  client.multi = function () {
    const queued = [];
    const chain = {};
    const methods = ['get', 'set', 'setEx', 'del', 'expire', 'incr', 'decr', 'exists',
      'lPush', 'rPush', 'lRem', 'sAdd', 'sRem', 'hSet', 'hDel'];
    methods.forEach((m) => {
      chain[m] = function (...args) { queued.push([m, args]); return chain; };
    });
    chain.exec = async function () {
      const results = [];
      for (const [m, args] of queued) results.push(await client[m](...args));
      return results;
    };
    return chain;
  };

  return client;
}

// Set NODE_ENV before ANY require('config') so node-config loads test.yaml and
// model.js exposes its config (Lesson.plugins etc.) under the 'test' env.
process.env.NODE_ENV = 'test';

// Firestore profile: TEST_DB_BACKEND=firestore runs the same suite against the
// Firestore emulator (FIRESTORE_EMULATOR_HOST must be set) instead of the
// in-process mongo memory server. All test files share ONE emulator project,
// so run this profile with --fileParallelism=false.
const FS_MODE = process.env.TEST_DB_BACKEND === 'firestore';

// Holds the in-memory redis client created during beforeAll so afterEach can
// flush it, clearing login rate-limit counters between tests file-wide.
let _redisClient;

beforeAll(async () => {
  // 1) Point config at the right backend BEFORE config/db (app.js) is required.
  //    config/db.js connects at require-time, so this must run first.
  // `inject` isn't a Vitest global; pull it via dynamic import (works in CJS).
  const { inject } = await import('vitest');
  const config = require('config');
  if (FS_MODE) {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('TEST_DB_BACKEND=firestore requires FIRESTORE_EMULATOR_HOST');
    }
    config.db.backend   = 'firestore';
    config.db.firestore = { projectId: process.env.GOOGLE_CLOUD_PROJECT || 'demo-trinket' };
    // Sessions can't ride the mongoose connection here; use the in-memory
    // catbox cache (same choice as the gcr docker-compose dev stack).
    config.app.plugins.session.cache = { backend: 'memory' };
  } else {
    const uri = inject('mongoUri');
    const u = new URL(uri);
    config.db.mongo.host = u.hostname;
    config.db.mongo.port = u.port;
    // Give each test FILE its own unique database so parallel workers don't
    // clobber each other's data via afterEach dropDatabase().
    config.db.mongo.database = 'test_' + Math.random().toString(36).slice(2);
  }

  // app.js exits(1) if the session cookie password is < 32 chars. Provide one.
  config.app.plugins.session.cookieOptions.password =
    'test-only-session-cookie-password-0123456789';

  // 2) Disable redis before app boot. config/redis.js and lib/util/queues.js
  //    read `config.db.redis.enabled !== false` at require-time: with it false,
  //    config/redis skips connecting and queues use the in-memory impl instead
  //    of bull. Without this, bull (node_redis v2) connects to localhost:6379
  //    and floods the run with uncaught ECONNREFUSED errors (non-zero exit).
  config.db.redis.enabled = false;

  // Mock redis.createClient with a small in-memory, redis-v4-compatible client.
  // lib/util/store.js captures `redisEnabled` at require-time (default true),
  // so even with config.db.redis.enabled=false it still takes the real-client
  // path on first Store.* call (e.g. course.test.js's rate-limit-key resets).
  // redis-mock is node_redis v2 (callback API, no async .connect()), so it
  // breaks Store under v4 in CI (no real redis to fall back on). This in-memory
  // client implements the v4 promise API Store/the rate-limiter actually use.
  const redis = require('redis');
  redis.createClient = () => (_redisClient = makeInMemoryRedisClient());

  // 3) Boot the app: registers model globals (Lesson, etc.) + connects via
  //    config/db. app.js exports the init() promise; await it so the globals
  //    (assigned inside init) are registered before tests run.
  await require('../../app.js');

  // 4) Wait for the mongoose connection to be ready (mongoose profile only —
  //    config/db.js never connects when db.backend is firestore).
  if (!FS_MODE) await mongoose.connection.asPromise();
});

afterEach(async () => {
  // NOTE: dropDatabase() removes indexes along with data, so DB-level unique
  // constraints (e.g. on username/email) are NOT enforced after the first test
  // in a file. Tests must rely on app-level uniqueness checks instead.
  if (FS_MODE) {
    // Wipe the emulator between tests (equivalent of dropDatabase).
    const projectId = (require('config').db.firestore || {}).projectId || 'demo-trinket';
    await fetch('http://' + process.env.FIRESTORE_EMULATOR_HOST +
      '/emulator/v1/projects/' + projectId + '/databases/(default)/documents',
      { method: 'DELETE' });
  } else if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db.dropDatabase();
  }
  // Clear rate-limit counters from the Store's backing client between tests.
  // When redis is disabled (test env), lib/util/store.js uses InMemoryClient —
  // a module-level singleton whose state persists across DB drops. After 10
  // login attempts the rate limiter returns 429 → switchUser throws. We clear
  // all rate:* keys here so every test starts with a clean rate-limit slate.
  // Store is required lazily (not at module level) so it loads AFTER beforeAll
  // has set config.db.redis.enabled=false and registered the redis mock.
  const Store = require('../../lib/util/store');
  const storeClient = await Store.getClient();
  const rateKeys = await storeClient.keys('rate:*');
  for (const k of rateKeys) await storeClient.del(k);
  // Also flush the redis mock client if one was created (when redis IS enabled).
  if (_redisClient) await _redisClient.flushAll();
});

afterAll(async () => {
  if (!FS_MODE) await mongoose.disconnect();
});
