# Test Rebuild — Slice 2a: Vitest Harness on mongodb-memory-server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up a Vitest test harness that boots the real app against an in-process `mongodb-memory-server` (no external Mongo) with redis mocked, and prove it by porting the smallest model test green. This unblocks porting every other model/API test.

**Architecture:** A Vitest `globalSetup` starts one `mongodb-memory-server` and shares its URI; a per-file `setupFiles` script points `config.db.mongo.*` at that URI, mocks `redis.createClient`, boots `app.js` (which registers the model globals and connects via `config/db.js`), waits for the connection, and drops the DB between tests. Then `test/lib/models/lesson.js` (chai/mocha) is ported to `test/lib/models/lesson.test.js` (Vitest) as the proof.

**Tech Stack:** Vitest, mongodb-memory-server, mongoose ^6 (unchanged), redis-mock (already a dep). CommonJS app.

## Global Constraints

- **Backend-neutral / no migration:** `config.db.backend` stays `mongoose`; `mongoose ^6` unchanged; only test-side code changes.
- **No external services:** tests must run with zero external Mongo/redis — `mongodb-memory-server` + `redis-mock` only.
- **Leave legacy mocha files alone except the one ported here.** Vitest still only runs `test/**/*.test.js`. The old `test/lib/**/*.js` (mocha) keep running under nothing (not executed) until their `.test.js` port lands.
- **Mongo binary compatibility:** pin the memory-server mongod binary to a 6.0.x line (compatible with mongoose 6 and close to picup's `mongo:5` runtime).

## Integration-risk note (read before Task 2)

This harness is the one genuinely finicky part of the whole initiative — three ordering hazards the TDD loop in Task 4 must resolve to green:
1. **Connect ordering:** `config.db.mongo.*` MUST be set *before* `app.js`/`config/db.js` is required (config/db connects at require-time).
2. **globalSetup → worker propagation:** values set in `globalSetup` do not automatically reach worker processes via `process.env`. Use Vitest's `provide`/`inject` to pass the URI (code below).
3. **Model globals:** the model tests use bare globals (`Lesson`), populated as a side effect of booting `app.js`. The setup must `require('../../app.js')` after config is pointed at the memory server.

Treat the code in Task 2/4 as the intended design; iterate it to green in Task 4 (the test passing is the contract, not the literal first draft).

---

### Task 1: Add mongodb-memory-server

**Files:** Modify `package.json` (devDeps)

- [ ] **Step 1: Install (needs network — run the install Bash call with the sandbox disabled)**

```bash
npm install --save-dev --legacy-peer-deps mongodb-memory-server@^10
```
Expected: `mongodb-memory-server` under devDependencies.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "test: add mongodb-memory-server (in-process Mongo for tests)"
```

---

### Task 2: Create the Vitest harness (globalSetup + per-file setup)

**Files:**
- Create: `test/helpers/mongo-global.mjs` (globalSetup — starts the memory server once)
- Create: `test/helpers/vitest-setup.cjs` (per-file — config + redis mock + app boot + db reset)

**Interfaces:**
- Produces: a Vitest run where every `*.test.js` file has the app booted against the memory server, `Lesson`/other model globals available, redis mocked, and a clean DB per test. Consumed by Task 3 (config wiring) and every future ported test.

- [ ] **Step 1: globalSetup — start one memory server, share its URI via `provide`**

Create `test/helpers/mongo-global.mjs`:
```js
import { MongoMemoryServer } from 'mongodb-memory-server';

// Vitest globalSetup: starts ONE in-process mongod for the whole run and
// hands its URI to workers via `provide` (process.env does NOT propagate).
export default async function ({ provide }) {
  const mongod = await MongoMemoryServer.create({ binary: { version: '6.0.14' } });
  provide('mongoUri', mongod.getUri());
  return async () => { await mongod.stop(); };
}
```

- [ ] **Step 2: per-file setup — point config at it, mock redis, boot app, reset DB**

Create `test/helpers/vitest-setup.cjs`:
```js
// CommonJS so it can require() the CJS app/config. Runs once per test file.
const { beforeAll, afterEach, afterAll, inject } = require('vitest');
const mongoose = require('mongoose');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';

  // 1) Point config at the memory server BEFORE config/db (app.js) is required.
  const uri = inject('mongoUri');
  const u = new URL(uri);
  const config = require('config');
  config.db.mongo.host = u.hostname;
  config.db.mongo.port = u.port;
  config.db.mongo.database = (u.pathname || '/test').slice(1) || 'test';

  // 2) Mock redis before app.js wires it up.
  const redis = require('redis');
  const redismock = require('redis-mock');
  redis.createClient = redismock.createClient;

  // 3) Boot the app: registers model globals (Lesson, etc.) + connects via config/db.
  require('../../app.js');

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
```

- [ ] **Step 3: Commit**

```bash
git add test/helpers/mongo-global.mjs test/helpers/vitest-setup.cjs
git commit -m "test: Vitest harness — app boot on mongodb-memory-server + redis mock"
```

---

### Task 3: Wire the harness into vitest.config.mjs

**Files:** Modify `vitest.config.mjs`

**Interfaces:** Consumes Task 2's two files. Produces a config that runs globalSetup + per-file setup for the suite.

- [ ] **Step 1: Add globalSetup + setupFiles**

In `vitest.config.mjs`, inside the `test: { ... }` block, add (keep `globals`, `environment`, `include`, `coverage`):
```js
    globalSetup: ['./test/helpers/mongo-global.mjs'],
    setupFiles: ['./test/helpers/vitest-setup.cjs'],
    testTimeout: 30000,   // first run downloads the mongod binary; boot takes a moment
```

- [ ] **Step 2: Confirm the existing unit test still passes (harness must not break pure tests)**

Run: `npm test`
Expected: `test/unit/objectUtils.test.js` still 7/7 PASS (the harness boots, but objectUtils doesn't depend on it). If the harness errors at boot, fix it here before Task 4.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.mjs
git commit -m "test: wire mongodb-memory-server harness into vitest config"
```

---

### Task 4: Port the smallest model test (lesson) as the harness proof

**Files:**
- Create: `test/lib/models/lesson.test.js`
- Reference (do not modify): `test/lib/models/lesson.js` (legacy mocha), `lib/models/plugins/ownable.js`

**Interfaces:** Consumes the harness (global `Lesson`, booted app). Produces the first model test green against the memory server — proof the harness works.

- [ ] **Step 1: Write the ported test**

The legacy test asserts the `Lesson` model registers the `ownable` plugin. Create `test/lib/models/lesson.test.js`:
```js
const _       = require('underscore');
const ownable = require('../../../lib/models/plugins/ownable');

describe('Lesson model', () => {
  describe('plugins', () => {
    it('implements the ownable plugin', () => {
      const plugin = _.find(Lesson.plugins, (p) => p === ownable);
      expect(plugin).toBeDefined();
    });
  });
});
```
(`Lesson` is a global from the booted app, per the harness. `describe`/`it`/`expect` are Vitest globals.)

- [ ] **Step 2: Run it — iterate to green**

Run: `npm test test/lib/models/lesson.test.js`
Expected: PASS. If it fails, the failure is almost certainly one of the three integration hazards from the note above — debug in this order: (a) is `Lesson` defined? (app boot / global registration) → check how `app.js` exposes models; (b) did mongoose connect? (`mongoose.connection.readyState` should be 1) → check the config override ran before `config/db`; (c) `inject('mongoUri')` returns the URI? → confirm globalSetup ran. Fix the harness files (Task 2) as needed and re-run until green.

- [ ] **Step 3: Run the whole suite (unit + lesson) green**

Run: `npm test`
Expected: `objectUtils` 7/7 + `lesson` 1/1, all green.

- [ ] **Step 4: Commit**

```bash
git add test/lib/models/lesson.test.js
git commit -m "test: port lesson model test to Vitest (harness proof)"
```

- [ ] **Step 5: Push + confirm CI (memory-server downloads the mongod binary in CI)**

```bash
git push origin tests/rebuild   # network: sandbox disabled
gh run watch
```
Expected: CI `success`. Note: the first CI run downloads the mongod binary (~adds time); if CI times out, raise the job timeout or add a binary cache step (record as a follow-up, don't block locally-green work).

---

## Self-Review

- **Spec coverage (2a scope):** in-process Mongo harness (Tasks 1–3) ✓ · app boot + redis mock + db reset (Task 2) ✓ · first model test ported & green (Task 4) ✓ · CI runs it (Task 4 step 5) ✓.
- **Backend-neutral / no migration:** only test-side files; mongoose ^6 untouched; `config.db.backend` untouched. ✓
- **Placeholders:** none — full harness + test code provided. The Task 4 iteration note is integration reality, not a placeholder (the green test is the contract).
- **Consistency:** `provide('mongoUri')` (globalSetup) ↔ `inject('mongoUri')` (setup) match; setupFiles path matches the created file.

## Decomposition — the rest of Slice 2 (separate plans after 2a)

- **2b — Port model tests:** course, user, trinket, plugins/roles, plugins/paginate, util/user → Vitest, applying a chai→Vitest transformation reference (`x.should.equal(y)`→`expect(x).toBe(y)`, `.should.exist`→`toBeDefined()`, sinon.spy/stub→`vi.fn`/`vi.spyOn`). ~6 files.
- **2c — Port API tests:** the 11 `test/lib/api/*.js` (supertest) → Vitest + modern supertest against the booted app. The larger chunk.
- **2d — Cleanup:** delete any legacy mocha files not ported; remove `mocha`/`chai`/`chai-as-promised`/`sinon`/`sinon-chai` devDeps + `test/mocha.opts`; switch CI to `npm ci`.
