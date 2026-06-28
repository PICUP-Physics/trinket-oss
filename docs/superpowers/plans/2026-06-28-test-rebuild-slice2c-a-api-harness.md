# Test Rebuild — Slice 2c-a: API/auth harness (flow on server.inject) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rewrite `test/helpers/flow.js` (the API request/auth helper) onto Hapi's native `server.inject()` so the API tests can run against the booted app with sessions/cookies, no listener/port, parallel-safe — proven by porting the smallest auth-exercising API tests (`login`, `logout`) green.

**Architecture:** The 2a harness boots the app per file (`await require('../../app.js')` → the resolved Hapi server). The new `flow` awaits that same server and issues requests via `server.inject()` (no real HTTP, no port → no `EADDRINUSE` across parallel files). It keeps a per-user cookie jar (capturing `set-cookie`, replaying it on later requests) and the legacy state surface the tests read (`lastResponse`/`wasOk`/`lastRedirect`/`lastContentType`/`activeUser`/`switchUser`), but every method now returns a promise (await-able) instead of taking a callback.

**Tech Stack:** Hapi `server.inject`, the 2a harness (mongodb-memory-server, redis disabled → sessions stored in Mongo), Vitest.

## Global Constraints

- **Backend-neutral / no migration:** change only `test/**`; no `lib/` runtime, no `config.db.backend`.
- **Harness contract (2a):** app booted per file; model globals (`User`, …) available; per-file unique DB; redis disabled (sessions persist in Mongo, so login/session works). `flow` must reuse the already-booted server, not boot its own.
- **No listener/port:** use `server.inject()` only. Do NOT call `server.start()` or use supertest against a port (parallel files would collide).
- **Preserve the flow API the tests use:** `flow.lastResponse.statusCode`, `.redirect`, `.body`; `flow.lastRedirect.pathname`; `flow.wasOk`; `flow.lastContentType`; `flow.switchUser(user)`; and the request methods (`login`, `logout`, `welcome`, `index`, `register`, `get`, `post`, …). Tests will `await` them.

## Integration-risk note (this is the finicky part — iterate to green)

Like the 2a harness, expect to iterate. The hazards:
1. **Server handle:** `require('../../app.js')` resolves to the Hapi server (its `module.exports = serverPromise`). `flow` must `await` it once and cache it.
2. **Auth/session over inject:** login must produce a session cookie; later authed requests must replay it. inject's response `set-cookie` is an array; the replayed `cookie` request header is `name=value; name2=value2` (strip attributes). Sessions are stored in Mongo (redis is off) — confirm the session survives between injects on the same server.
3. **Response shape mapping:** map Hapi inject result → the legacy shape: `statusCode`→`res.statusCode`, `body`→`res.result` (parsed), `text`→`res.payload` (raw), `redirect`→`statusCode in [300,399]`, `lastRedirect`→`url.parse(res.headers.location)`, `lastContentType`→`res.headers['content-type']`.
4. **Multipart uploads** (`flow.uploadFile`/`uploadIpynb`, used by `files.js`) are harder over inject (need a multipart payload). They are NOT needed for `login`/`logout` — stub or defer them to 2c-b; do not block 2c-a on them.

The proof is `login.test.js` + `logout.test.js` green. Treat the code below as the intended design; make those tests pass.

---

### Task 1: Rewrite `flow` onto `server.inject` (promise-based)

**Files:** Create `test/helpers/flow.cjs` (new, replaces the supertest `flow.js` for ported tests). Reference (don't modify): `test/helpers/flow.js` (legacy — the full method list to port), `test/helpers/defaults.js`.

**Interfaces:** Produces a singleton `flow` with: `switchUser(user)`, request methods returning promises, and the state fields above.

- [ ] **Step 1: Write the harness core**

Create `test/helpers/flow.cjs` (CommonJS). Core design — port ALL methods from the legacy `flow.js` following this pattern (each legacy `this.verb(url).send(body).end(cb)` becomes a thin wrapper returning `this._inject(...)`):
```js
const url = require('url');
const defaults = require('./defaults');

let _server;
async function getServer() {
  if (!_server) _server = await require('../../app.js'); // serverPromise resolves to the Hapi server
  return _server;
}

function cookieHeader(setCookie) {
  // set-cookie is an array of "name=value; Path=/; ..." — keep only name=value pairs
  return (setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

const flow = {
  activeUser: 'user',
  cookies: {},               // { [user]: setCookieArray }
  lastResponse: null, lastError: null, wasOk: false, lastRedirect: null, lastContentType: null,

  async _inject(method, path, payload) {
    const server = await getServer();
    const headers = { referer: '' };
    if (this.cookies[this.activeUser]) headers.cookie = cookieHeader(this.cookies[this.activeUser]);
    const opts = { method, url: path, headers };
    if (payload !== undefined) opts.payload = payload;
    const res = await server.inject(opts);
    if (res.headers['set-cookie']) this.cookies[this.activeUser] = res.headers['set-cookie'];
    this.lastResponse = {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.result,
      text: res.payload,
      redirect: res.statusCode >= 300 && res.statusCode < 400,
    };
    this.lastError = null;
    this.wasOk = true;
    this.lastContentType = res.headers['content-type'];
    this.lastRedirect = res.headers.location ? url.parse(res.headers.location) : null;
    return this.lastResponse;
  },

  get(p) { return this._inject('GET', p); },
  post(p, body) { return this._inject('POST', p, body); },
  put(p, body) { return this._inject('PUT', p, body); },
  del(p) { return this._inject('DELETE', p); },

  // --- ported request methods (one per legacy flow method) ---
  index() { return this.get('/'); },
  login(body) { return this.post('/login', defaults.extend(body || {}, 'login')); },
  logout() { return this.get('/logout'); },
  welcome() { return this.get('/welcome'); },
  home() { return this.get('/home'); },
  admin() { return this.get('/admin/users'); },
  register(body) { return this.post('/users', defaults.extend(defaults.extend(body || {}, 'user'), 'recaptcha')); },
  // ...PORT THE REMAINING ~30 methods from legacy flow.js the same way (createCourse, getCourse,
  //    addNewLesson, createTrinket, sendPassReset, etc.). Multipart uploadFile/uploadIpynb: leave a
  //    `throw new Error('multipart upload: implement in 2c-b')` stub for now (not needed by login/logout).

  async switchUser(user) {
    this.activeUser = user;
    if (this.cookies[user]) return;
    const creds = { email: defaults[user].email, password: defaults[user].password };
    const doc = await new Promise((res, rej) => User.findByLogin(creds.email, (e, d) => e ? rej(e) : res(d)));
    if (!doc) await new User(defaults[user]).save();
    const r = await this.login(creds);
    if (r.statusCode !== 302) throw new Error('Failed to log in "' + user + '"');
  },
};

module.exports = flow;
```

- [ ] **Step 2: Commit the harness**

```bash
git add test/helpers/flow.cjs
git commit -m "test: API flow harness on Hapi server.inject (promise-based)"
```

---

### Task 2: Port `logout.js` (simple authed GET — first proof)

**Files:** Create `test/lib/api/logout.test.js`; reference `test/lib/api/logout.js` (33 lines).

- [ ] **Step 1:** Port it. Drop the `module.exports = function(){ ... }` wrapper → a top-level `describe`. Replace `flow.X(cb)` + `done` with `await flow.X()`; swap chai assertions (Transformation Reference from the 2b plan: `flow.wasOk.should.be.true` → `expect(flow.wasOk).toBe(true)`, `flow.lastResponse.statusCode.should.eql(302)` → `expect(flow.lastResponse.statusCode).toBe(302)`, `flow.lastRedirect.pathname.should.eql('/login')` → `expect(flow.lastRedirect.pathname).toBe('/login')`). Require the new harness: `const flow = require('../../helpers/flow.cjs');`. Use `beforeEach` for any `before` fixtures (per the 2a DB-reset-per-test rule).
- [ ] **Step 2:** Run `npm test test/lib/api/logout.test.js` (network for mongod binary → `dangerouslyDisableSandbox: true`) → iterate to green.
- [ ] **Step 3:** `git add test/lib/api/logout.test.js && git commit -m "test: port logout API test to Vitest"`

---

### Task 3: Port `login.js` (auth flow — the real harness proof)

**Files:** Create `test/lib/api/login.test.js`; reference `test/lib/api/login.js` (79 lines — exercises `switchUser`, invalid/valid login, redirects, session).

- [ ] **Step 1:** Port it following Task 2's pattern + the 2b Transformation Reference. This is the real proof of the auth/session/cookie path (`flow.switchUser('user')`, valid/invalid login, `/welcome` gated redirect). Convert all `done`-callbacks to `await`.
- [ ] **Step 2:** Run `npm test test/lib/api/login.test.js` → iterate to green. This is where the cookie/session hazards surface — debug per the Integration-risk note (cookie replay, session persistence in Mongo, redirect mapping). If after genuine iteration the session path can't be made to work over inject, STOP and report BLOCKED with specifics.
- [ ] **Step 3:** `git add test/lib/api/login.test.js && git commit -m "test: port login API test to Vitest"`

---

### Task 4: Full suite + CI

- [ ] **Step 1:** `npm test` (sandbox disabled) → expect the prior 62 + logout + login green, 0 failed.
- [ ] **Step 2:** `git push origin tests/rebuild` then `gh run watch` (sandbox disabled) → CI `success`.
- [ ] **Step 3:** Report total counts, what you changed from the intended `flow.cjs` design to get auth working (the integration reality), and the CI URL.

---

## Self-Review

- **Spec coverage (2c-a):** flow rewritten on inject (Task 1) ✓; auth proven via login+logout (Tasks 2–3) ✓; suite+CI green (Task 4) ✓.
- **Backend-neutral / no migration / no listener:** only `test/**`; inject-only. ✓
- **Placeholders:** the harness core is complete; the remaining ~30 thin request-method ports follow the documented pattern from the legacy `flow.js` (the source + pattern are the spec). Multipart upload stub is explicitly deferred to 2c-b.
- **Consistency:** the response-shape mapping matches what the ported tests read (`lastResponse.statusCode`/`.redirect`/`.body`, `lastRedirect.pathname`, `wasOk`, `lastContentType`).

## Decomposition — remaining

- **2c-b — Port the rest of the API tests:** registration, admin, profile, course (369 lines), files (multipart — implement the upload path in `flow.cjs`), forgot_pass, trinket, legacy. Apply the same pattern; drop the legacy `index.js` sequence orchestrator (Vitest auto-discovers files).
- **2d — Cleanup:** delete legacy mocha `.js` test files + `test/mocha.opts` + legacy `flow.js`/`helpers/db.js`; remove `mocha`/`chai`/`chai-as-promised`/`sinon`/`sinon-chai`/`supertest` devDeps; switch CI to `npm ci`.
