# Test Rebuild — Slice 2b: Port Model Tests to Vitest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the 6 model/util test files from chai+mocha to Vitest on the 2a harness, preserving their coverage. Each ported file runs green against `mongodb-memory-server`.

**Architecture:** Each `test/lib/.../X.js` (mocha) becomes `test/lib/.../X.test.js` (Vitest) by applying the Transformation Reference below: swap chai `.should` assertions for `expect`, sinon for `vi`, and `done`-callbacks (incl. nested mongoose `save(cb)`) for `async/await` (mongoose 6 returns promises). The 2a harness already boots the app (model globals like `User`/`Course`/`Lesson`/`Material`) and resets the DB per test, so ported tests drop the old `chai`/`sinon`/`helpers/db` requires.

**Tech Stack:** Vitest (globals + `vi`), mongoose ^6 (promise API), the 2a harness.

## Global Constraints

- **Backend-neutral / no migration:** change only `test/**`; no `lib/` runtime code, no `config.db.backend`, mongoose ^6 unchanged.
- **Harness contract (from 2a — do not re-implement):** `NODE_ENV=test`, app booted, model globals available, DB dropped per test, redis disabled, vitest globals on. Ported tests rely on this; they don't set up their own DB/app.
- **Preserve coverage:** every `it` in the legacy file becomes an `it` in the port. If a ported test fails because the asserted behavior genuinely no longer holds (NOT a porting mistake), convert it to `it.skip` with a `// TODO(slice-2b): <why>` note and report it — never silently drop an assertion.
- **Vitest include glob is `test/**/*.test.js`** — the legacy `.js` files stay inert; you ADD `.test.js` siblings. Leave the legacy files in place (Slice 2d deletes them).

## Transformation Reference (apply to every file)

**Requires — drop / keep:**
- DROP: `require('chai').should()`, `require('sinon')`, `require('../../helpers/db')` (harness owns the DB; use the `vi` global for mocks).
- KEEP: `require('underscore')`, `require('../../helpers/defaults')`, model-plugin requires, `require('mongoose').Types.ObjectId`.
- No import needed for `describe`/`it`/`expect`/`vi`/`beforeEach`/`afterEach` (Vitest globals).

**Assertions (chai should-style → Vitest):**
| chai | Vitest |
|---|---|
| `x.should.equal(y)` | `expect(x).toBe(y)` |
| `x.should.eql(y)` | `expect(x).toEqual(y)` |
| `x.should.be.true` / `.be.false` | `expect(x).toBe(true)` / `toBe(false)` |
| `should.exist(x)` | `expect(x != null).toBe(true)` |
| `should.not.exist(x)` | `expect(x == null).toBe(true)` |
| `x.should.have.property('p')` | `expect(x).toHaveProperty('p')` |
| `x.should.have.property('p', v)` | `expect(x).toHaveProperty('p', v)` |
| `c.should.include(v)` / `.not.include(v)` | `expect(c).toContain(v)` / `.not.toContain(v)` |
| `x.should.match(re)` / `.not.match(re)` | `expect(x).toMatch(re)` / `.not.toMatch(re)` |
| `x.should.be.instanceof(C)` | `expect(x).toBeInstanceOf(C)` |
| `x.should.be.above(n)` | `expect(x).toBeGreaterThan(n)` |

**Spies/stubs (sinon → vi):**
| sinon | Vitest |
|---|---|
| `sinon.spy()` | `vi.fn()` |
| `sinon.spy(obj,'m')` | `vi.spyOn(obj,'m')` |
| `sinon.stub(obj,'m').returns(v)` | `vi.spyOn(obj,'m').mockReturnValue(v)` |
| `spy.should.have.been.calledOnce` | `expect(spy).toHaveBeenCalledOnce()` |
| `spy.should.have.been.calledWith(a)` | `expect(spy).toHaveBeenCalledWith(a)` |
| `.restore()` per stub | add `afterEach(() => vi.restoreAllMocks())` once per file |

**Async (`done`-callback → `async/await`):**
- `it('...', function(done){ x.save(function(err){ …; done(); }); })` → `it('...', async () => { await x.save(); … })`.
- Nested callbacks → sequential `await`s. mongoose `save()`/`find()`/`exec()` all return promises in v6.
- Non-promise callbacks (e.g. `course.copy(user, cb)`): wrap — `const r = await new Promise((res, rej) => course.copy(user, (err, c) => err ? rej(err) : res(c)));`
- Error-path `done(err)` just disappears: let the `await` reject (Vitest fails the test on rejection).

---

### Task 1: Port `course.js` (worked example — establishes the pattern)

**Files:** Create `test/lib/models/course.test.js`; reference (don't modify) `test/lib/models/course.js`, `lib/models/plugins/ownable.js`.

- [ ] **Step 1: Write the ported test**

```js
const _       = require('underscore');
const ownable = require('../../../lib/models/plugins/ownable');

describe('Course model', () => {
  describe('plugins', () => {
    it('implements the ownable plugin', () => {
      const plugin = _.find(Course.plugins, (p) => Array.isArray(p) && p[0] === ownable);
      expect(plugin != null).toBe(true);
    });
  });

  describe('object methods', () => {
    describe('copy', () => {
      it('copies the course fields', async () => {
        const owner = new User({ fullname: 'test course owner', username: 'testcourseowner', email: 'testcourseowner@email.com', password: 'password' });
        const user  = new User({ fullname: 'test user', username: 'testuser', email: 'testuser@email.com', password: 'password' });
        const material = new Material({ name: 'material name', content: 'material content', _owner: owner });
        await material.save();
        const lesson = new Lesson({ name: 'lesson name', _owner: owner, materials: [material.id] });
        await lesson.save();
        const course = new Course({ name: 'course name', description: 'course description', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
        await course.save();

        const copy = await new Promise((resolve, reject) => course.copy(user, (err, c) => err ? reject(err) : resolve(c)));
        expect(copy).toHaveProperty('name', course.name);
        expect(copy).toHaveProperty('description', course.description);
        expect(copy).toHaveProperty('lessons');
      });
    });
  });
});
```

- [ ] **Step 2: Run + iterate to green**

Run (network for the mongod binary on a cold cache — use `dangerouslyDisableSandbox`): `npm test test/lib/models/course.test.js`
Expected: 2/2 PASS. If `copy` fails, check the harness provides `User`/`Material`/`Lesson`/`Course` globals and that `course.copy`'s callback signature is `(err, copy)`. Fix and re-run.

- [ ] **Step 3: Commit**

```bash
git add test/lib/models/course.test.js
git commit -m "test: port course model test to Vitest"
```

---

### Task 2: Port `util/user.js`

**Files:** Create `test/lib/util/user.test.js`; reference `test/lib/util/user.js` (41 lines, 6 `done` callbacks).

- [ ] **Step 1:** Port `test/lib/util/user.js` → `test/lib/util/user.test.js` applying the Transformation Reference and the Task 1 pattern. Drop chai/sinon/db requires; convert the 6 `done`-callbacks to `async/await`; swap assertions.
- [ ] **Step 2:** Run `npm test test/lib/util/user.test.js` → iterate to green (skip+TODO+report any test whose asserted behavior no longer holds).
- [ ] **Step 3:** `git add test/lib/util/user.test.js && git commit -m "test: port util/user test to Vitest"`

---

### Task 3: Port `models/plugins/paginate.js`

**Files:** Create `test/lib/models/plugins/paginate.test.js`; reference `test/lib/models/plugins/paginate.js` (265 lines, synchronous — no `done`, no `then`).

- [ ] **Step 1:** Port applying the reference. This file is synchronous, so the async conversion mostly doesn't apply — focus on the assertion swaps (`.should.eql`/`.should.have.property`/etc.) and dropping chai/sinon/db requires. It's the largest assertion surface; work top-to-bottom.
- [ ] **Step 2:** Run `npm test test/lib/models/plugins/paginate.test.js` → iterate to green (skip+TODO+report genuine behavior mismatches).
- [ ] **Step 3:** `git add test/lib/models/plugins/paginate.test.js && git commit -m "test: port paginate plugin test to Vitest"`

---

### Task 4: Port `models/user.js`

**Files:** Create `test/lib/models/user.test.js`; reference `test/lib/models/user.js` (142 lines, 24 `done` callbacks — heavy async conversion).

- [ ] **Step 1:** Port applying the reference + Task 1 pattern. The bulk of work is converting 24 `done`-callbacks to `async/await` (mongoose ops via `await`; non-promise callbacks via the Promise-wrap). Drop chai/sinon/db; swap assertions; sinon.spy → `vi.fn`/`vi.spyOn` + `afterEach(() => vi.restoreAllMocks())`.
- [ ] **Step 2:** Run `npm test test/lib/models/user.test.js` → iterate to green (skip+TODO+report genuine mismatches).
- [ ] **Step 3:** `git add test/lib/models/user.test.js && git commit -m "test: port user model test to Vitest"`

---

### Task 5: Port `models/trinket.js`

**Files:** Create `test/lib/models/trinket.test.js`; reference `test/lib/models/trinket.js` (206 lines, 22 `done` + 2 `.then`).

- [ ] **Step 1:** Port applying the reference + Task 1 pattern. Convert both `done`-callbacks and the existing `.then` chains to `async/await`; drop chai/sinon/db; swap assertions.
- [ ] **Step 2:** Run `npm test test/lib/models/trinket.test.js` → iterate to green (skip+TODO+report genuine mismatches).
- [ ] **Step 3:** `git add test/lib/models/trinket.test.js && git commit -m "test: port trinket model test to Vitest"`

---

### Task 6: Port `models/plugins/roles.js`

**Files:** Create `test/lib/models/plugins/roles.test.js`; reference `test/lib/models/plugins/roles.js` (201 lines, 30 `done` + 9 `.then` — the biggest async surface).

- [ ] **Step 1:** Port applying the reference + Task 1 pattern. Largest async-conversion surface (30 `done` + 9 `.then` → `async/await`); drop chai/sinon/db; swap assertions; sinon.spy → vi.
- [ ] **Step 2:** Run `npm test test/lib/models/plugins/roles.test.js` → iterate to green (skip+TODO+report genuine mismatches).
- [ ] **Step 3:** `git add test/lib/models/plugins/roles.test.js && git commit -m "test: port roles plugin test to Vitest"`

---

### Task 7: Full suite + CI

- [ ] **Step 1:** Run the whole suite: `npm test` (sandbox disabled). Expected: objectUtils + lesson + the 6 newly ported files all green (note any `it.skip` count + their TODOs).
- [ ] **Step 2:** Push + confirm CI: `git push origin tests/rebuild` then `gh run watch` (network → sandbox disabled). Expected CI `success`.
- [ ] **Step 3:** Report the total test count, any skipped tests (with their TODO reasons), and the CI URL.

---

## Self-Review

- **Spec coverage (2b):** all 6 model/util files ported (Tasks 1–6) ✓; suite + CI green (Task 7) ✓.
- **Backend-neutral / no migration:** only `test/**`; mongoose ^6 untouched. ✓
- **Placeholders:** the Transformation Reference + worked example + the existing source files are the complete spec for each mechanical port; per-file tasks name file-specific gotchas (async-conversion load, sinon usage). The skip+TODO rule prevents silent coverage loss.
- **Consistency:** every ported file relies only on the documented 2a harness contract; assertion/spy mappings are uniform across tasks.

## Decomposition — remaining (separate plans)

- **2c — API tests:** the 11 `test/lib/api/*.js` (supertest) → Vitest + modern supertest against the booted app. (Larger; needs an HTTP-request helper against the harness app.)
- **2d — Cleanup:** delete legacy mocha `.js` test files + `test/mocha.opts`; remove `mocha`/`chai`/`chai-as-promised`/`sinon`/`sinon-chai` devDeps; switch CI to `npm ci`.
