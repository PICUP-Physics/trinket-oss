# Test Rebuild — Slice 2c-b: Port the remaining API tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the remaining 8 API test files from chai+mocha (via the legacy `flow.js`) to Vitest on the `flow.cjs` inject harness, preserving coverage — plus implement the multipart upload path in `flow.cjs` so `files.js` can be ported. Each ported file runs green against the booted app.

**Architecture:** Each `test/lib/api/X.js` (a `module.exports = function(){…}` mocha suite) becomes a standalone `test/lib/api/X.test.js` (top-level `describe`). Requests go through the `flow.cjs` harness from 2c-a (Hapi `server.inject`, per-user cookie jar, `switchUser` login). The only new harness work is multipart form upload (currently stubbed), needed by `files.js`.

**Tech Stack:** Vitest, the `flow.cjs` inject harness (2c-a), the 2a Mongo-memory harness, `form-data` for multipart.

## Global Constraints

- **Backend-neutral / no migration:** change only `test/**`; no `lib/` runtime, no `config.db.backend`. (Note: the `shortCode 10→12` model inconsistency is an **upstream** issue — do NOT touch `lib/models/trinket.js`; it's out of scope here.)
- **2a harness contract:** app booted per file; model globals; per-file unique DB; DB dropped per test; redis disabled.
- **2c-a flow.cjs contract (rely on it, don't re-implement):** `flow` issues requests via `server.inject` (no listener/port); `getServer()` runs `server.initialize()` once; `switchUser(user)` logs in + caches the cookie. **Every API `.test.js` MUST reset `flow.cookies = {}` in a top-level `beforeEach`** (the DB resets per test, so a cached session would point at a dropped user). `NODE_CONFIG_PERSIST_ON_CHANGE='N'` is already set at the top of `flow.cjs`.
- **Preserve coverage:** every `it` in the legacy file becomes an `it`. If a ported test fails because the asserted behavior genuinely no longer holds (NOT a porting mistake), `it.skip` it with a `// TODO(slice-2c-b): <why>` note and report it — never silently drop coverage. (The `trinket.js` API test may hit shortCode-regeneration weirdness from the upstream bug; if so, skip+TODO and reference the upstream issue rather than asserting around it.)
- **Leave `test/lib/api/index.js`** (the legacy sequence orchestrator, a `.js` not `.test.js` → already inert under Vitest's glob) in place; Slice 2d deletes it.

## API-port pattern (apply to every file)

1. **Wrapper → standalone:** drop `module.exports = function(){ … }`; the inner `describe(...)` becomes top-level.
2. **Requires:** `const flow = require('../../helpers/flow.cjs');` (+ `defaults` if used). Drop `chai`/`sinon`/legacy `flow`/`helpers/db`.
3. **Cookie reset:** add at top of the file's top-level `describe`:
   ```js
   beforeEach(() => { flow.cookies = {}; });
   ```
4. **Fixtures:** legacy `before`/`after` → `beforeEach`/`afterEach` (per-test DB reset). Create users via `await flow.switchUser('user')` (or `'admin'`/etc. per `defaults`).
5. **Async:** `flow.X(args, done)` + `done` → `await flow.X(args)`. Then assert on `flow.lastResponse.statusCode` / `.redirect` / `.body`, `flow.lastRedirect.pathname`, `flow.wasOk`, `flow.lastContentType`.
6. **Assertions:** chai→Vitest per the 2b Transformation Reference (`x.should.eql(y)`→`expect(x).toEqual(y)`, `.should.be.true`→`toBe(true)`, `should.exist(x)`→`expect(x!=null).toBe(true)`, `.should.have.property`→`toHaveProperty`, etc.).

Each per-file task: apply this pattern to the source file, run `npm test <file>` (network for mongod binary on cold cache → `dangerouslyDisableSandbox: true`), iterate to green, commit `test: port <name> API test to Vitest`.

---

### Task 1: Port `profile.js` (smallest authed API test — pattern check)
**Files:** Create `test/lib/api/profile.test.js`; reference `test/lib/api/profile.js` (49 lines).
- [ ] Apply the API-port pattern. Likely uses `switchUser('user')` + `updateProfile`. Run → green. Commit.

### Task 2: Port `admin.js`
**Files:** Create `test/lib/api/admin.test.js`; reference `test/lib/api/admin.js` (79 lines).
- [ ] Apply the pattern. Admin routes need an admin session — use `switchUser('admin')` (per `defaults.admin`). Run → green. Commit.

### Task 3: Port `legacy.js`
**Files:** Create `test/lib/api/legacy.test.js`; reference `test/lib/api/legacy.js` (95 lines).
- [ ] Apply the pattern. Run → green (skip+TODO genuine mismatches). Commit.

### Task 4: Port `forgot_pass.js`
**Files:** Create `test/lib/api/forgot_pass.test.js`; reference `test/lib/api/forgot_pass.js` (140 lines).
- [ ] Apply the pattern (uses `sendPassReset`/`resetPassForm`/`savePass`). Reset-key flows may read a token from the created user — fetch it via the `User` global if needed. Run → green. Commit.

### Task 5: Port `registration.js`
**Files:** Create `test/lib/api/registration.test.js`; reference `test/lib/api/registration.js` (149 lines).
- [ ] Apply the pattern (uses `register`). Run → green. Commit.

### Task 6: Port `trinket.js`
**Files:** Create `test/lib/api/trinket.test.js`; reference `test/lib/api/trinket.js` (136 lines).
- [ ] Apply the pattern (uses `createTrinket`/`getTrinket`/`forkTrinket`/`runTrinket`/etc.). **If any assertion fails due to the upstream shortCode 10↔12 regeneration bug, `it.skip` with `// TODO(slice-2c-b): upstream shortCode bug, see trinketapp issue` and report it — do not assert around it.** Run → green. Commit.

### Task 7: Port `course.js` (largest — 369 lines)
**Files:** Create `test/lib/api/course.test.js`; reference `test/lib/api/course.js` (369 lines).
- [ ] Apply the pattern (uses `createCourse`/`getCourse`/`addNewLesson`/`addNewMaterial`/`updateCourse`/etc., heavily). Work top-to-bottom; many authed CRUD flows. Run → green (skip+TODO genuine mismatches). Commit.

---

### Task 8: Multipart upload in `flow.cjs` + port `files.js` (integration-risk)

**Files:** Modify `test/helpers/flow.cjs` (replace the `uploadFile`/`uploadIpynb` stubs); create `test/lib/api/files.test.js`; reference `test/lib/api/files.js` (119 lines), `test/helpers/defaults.js` (`defaults.file`/`defaults.ipynb`: `{ type, upload }` where `upload` is a fixture file path).

**Integration-risk note:** `server.inject` needs a fully-built multipart body, not supertest's `.field()/.attach()`. Use the `form-data` package: append the `type` field + the file (read as a buffer), then pass `form.getBuffer()` as `payload` and `form.getHeaders()` as `headers` to inject. Iterate to green.

- [ ] **Step 1:** Ensure `form-data` is available (`node -e "require('form-data')"`; if missing, `npm install --save-dev form-data` with `dangerouslyDisableSandbox: true`).
- [ ] **Step 2:** Implement in `flow.cjs` (replace the stubs):
```js
const fs = require('fs');
const FormData = require('form-data');

async function injectMultipart(flow, path, type, filePath) {
  const form = new FormData();
  form.append('type', type);
  form.append('upload', fs.readFileSync(filePath), { filename: require('path').basename(filePath) });
  const server = await getServer();
  const headers = form.getHeaders();
  if (flow.cookies[flow.activeUser]) headers.cookie = cookieHeader(flow.cookies[flow.activeUser]);
  const res = await server.inject({ method: 'POST', url: path, payload: form.getBuffer(), headers });
  return flow._record(res); // factor the res→state mapping out of _inject into a shared _record(res)
}
```
  (Refactor the response→state mapping in `_inject` into a shared `_record(res)` helper so both paths use it. Then `uploadFile(body)` → `injectMultipart(this, '/file', defaults.file.type, defaults.file.upload)`, `uploadIpynb` likewise with `defaults.ipynb`.)
- [ ] **Step 3:** Port `test/lib/api/files.js` → `files.test.js` applying the API-port pattern (uses `uploadFile`/`uploadIpynb`/`downloadFile`). Run `npm test test/lib/api/files.test.js` → iterate to green. If multipart can't be made to work over inject after genuine iteration, STOP and report BLOCKED with specifics.
- [ ] **Step 4:** Commit `test: multipart upload in flow harness + port files API test`.

---

### Task 9: Full suite + CI

- [ ] **Step 1:** `npm test` (sandbox disabled) → expect the prior 69 + the 8 newly ported files green, 0 failed. Note any `it.skip` (with TODO reasons).
- [ ] **Step 2:** `git push origin tests/rebuild` then `gh run watch` (sandbox disabled) → CI `success`.
- [ ] **Step 3:** Report total counts, any skipped tests + reasons, and the CI URL.

---

## Self-Review

- **Spec coverage (2c-b):** all 8 remaining API files ported (Tasks 1–8) ✓; multipart harness path added (Task 8) ✓; suite+CI green (Task 9) ✓.
- **Backend-neutral / no migration:** only `test/**`; `lib/` (incl. the upstream shortCode bug) untouched. ✓
- **Placeholders:** the API-port pattern + 2b Transformation Reference + the existing source files are the complete spec for each mechanical port; per-file tasks name auth + method specifics. Multipart (the one non-mechanical task) has concrete code. skip+TODO rule prevents silent coverage loss.
- **Consistency:** every ported file uses the documented `flow.cjs` contract (inject, `switchUser`, per-test cookie reset); response-shape reads match `flow.cjs`'s `_record` mapping.

## Decomposition — remaining after 2c-b

- **2d — Cleanup:** delete legacy mocha `.js` test files (incl. `test/lib/api/index.js`, the orchestrator) + `test/mocha.opts` + legacy `flow.js`/`helpers/db.js`; remove `mocha`/`chai`/`chai-as-promised`/`sinon`/`sinon-chai`/`supertest` devDeps; switch CI to `npm ci`. Then the branch is ready for the final whole-branch review + PR(s) to picup/main.
