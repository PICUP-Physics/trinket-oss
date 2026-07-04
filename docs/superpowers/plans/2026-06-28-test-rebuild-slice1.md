# Test Rebuild — Slice 1: Node 20 + Vitest + CI Rails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the modern test rails — Node 20, Vitest, a first real unit test, and GitHub Actions CI — so every later slice has a green, automated harness to build on.

**Architecture:** Pin Node 20 (Dockerfile + `.nvmrc` + `engines`). Add Vitest with a dedicated `vitest.config.mjs` that only picks up new `*.test.js` files (the legacy mocha files under `test/lib/**` are left untouched until Slice 2). Prove the harness with a pure-function unit test against `lib/util/objectUtils.js`. Add a GitHub Actions workflow that installs deps on Node 20 and runs the suite on every push/PR.

**Tech Stack:** Node 20, Vitest + `@vitest/coverage-v8`, GitHub Actions. CommonJS app (tests use `require`).

## Global Constraints

- **Backend-neutral:** do NOT change `config.db.backend` or any runtime backend selection. (Slice 1 touches no runtime code.)
- **No forced data migration:** Node 16→20 only; `mongoose ^6` unchanged (already proven on Node 20 in the fork).
- **Mergeable to picup/main:** everything here is backend-agnostic and Mongo-safe.
- **Leave legacy tests alone:** `test/lib/**/*.js` (mocha) are not run and not modified in this slice; Vitest is scoped to `test/**/*.test.js`.
- **Node version (verbatim):** `node:20-bullseye` / `.nvmrc` = `20` / `engines.node` = `>=20`.

---

### Task 1: Pin Node 20

**Files:**
- Modify: `Dockerfile:2`
- Create: `.nvmrc`
- Modify: `package.json` (add `engines`)

**Interfaces:**
- Produces: a repo pinned to Node 20 (consumed implicitly by CI in Task 4 and by all later work).

- [ ] **Step 1: Bump the Docker base image**

In `Dockerfile`, change line 2 from:
```dockerfile
FROM node:16-bullseye
```
to:
```dockerfile
FROM node:20-bullseye
```

- [ ] **Step 2: Create `.nvmrc`**

Create `.nvmrc` with exactly:
```
20
```

- [ ] **Step 3: Add an `engines` field to `package.json`**

In `package.json`, add a top-level `engines` block (next to `"scripts"`):
```json
  "engines": {
    "node": ">=20"
  },
```

- [ ] **Step 4: Verify consistency**

Run:
```bash
grep -n "node:20" Dockerfile && cat .nvmrc && grep -A2 '"engines"' package.json
```
Expected: Dockerfile shows `FROM node:20-bullseye`, `.nvmrc` prints `20`, `engines.node` is `>=20`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .nvmrc package.json
git commit -m "chore: pin Node 20 (Dockerfile, .nvmrc, engines)"
```

---

### Task 2: Add Vitest + config + scripts

**Files:**
- Modify: `package.json` (devDeps + scripts)
- Create: `vitest.config.mjs`
- Modify: `.gitignore` (ignore `coverage/`)

**Interfaces:**
- Produces: `npm test` runs Vitest over `test/**/*.test.js` with globals (`describe`/`it`/`expect`) enabled and v8 coverage available via `npm run test:coverage`.

- [ ] **Step 1: Install Vitest + coverage (Node 20)**

Run:
```bash
node --version   # expect v20.x — use `nvm use` if needed
npm install --save-dev --legacy-peer-deps vitest@^2 @vitest/coverage-v8@^2
```
Expected: both packages added under `devDependencies`.

- [ ] **Step 2: Add npm scripts**

In `package.json` `"scripts"`, replace `"test": "mocha"` with:
```json
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
```
(Leave the legacy mocha/chai/sinon devDeps in place for now — Slice 2 removes them when the old tests are ported.)

- [ ] **Step 3: Create `vitest.config.mjs`**

Create `vitest.config.mjs` with exactly:
```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only the new tests for now; legacy mocha files (test/lib/**) are ported in Slice 2.
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: Ignore the coverage dir**

Append to `.gitignore`:
```
coverage
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.mjs .gitignore
git commit -m "test: add Vitest (config, scripts, coverage)"
```

---

### Task 3: First real unit test (objectUtils) — prove the harness

**Files:**
- Create: `test/unit/objectUtils.test.js`
- Under test (do not modify): `lib/util/objectUtils.js` (exports `pull(fields, source, target)`, `serialize(json)`)

**Interfaces:**
- Consumes: `require('../../lib/util/objectUtils')` → `{ pull, serialize }`.
- Produces: a green unit suite proving Vitest runs real app code on Node 20.

- [ ] **Step 1: Write the test**

Create `test/unit/objectUtils.test.js`:
```js
const { pull, serialize } = require('../../lib/util/objectUtils');

describe('objectUtils.pull', () => {
  it('copies fields flagged true/1', () => {
    expect(pull({ a: true, b: 1 }, { a: 'x', b: 'y', c: 'z' })).toEqual({ a: 'x', b: 'y' });
  });

  it('renames via a string mapping', () => {
    expect(pull({ name: 'fullName' }, { fullName: 'Ada' })).toEqual({ name: 'Ada' });
  });

  it('recurses into nested object specs', () => {
    expect(pull({ owner: { id: true } }, { owner: { id: 7, secret: 'no' } }))
      .toEqual({ owner: { id: 7 } });
  });

  it('throws on an unrecognized field spec', () => {
    expect(() => pull({ a: 99 }, { a: 1 })).toThrow(/unrecognized field value/);
  });
});

describe('objectUtils.serialize', () => {
  it('returns primitives unchanged', () => {
    expect(serialize(42)).toBe(42);
  });

  it('calls .serialize() when present', () => {
    expect(serialize({ serialize: () => 'custom' })).toBe('custom');
  });

  it('drops null/undefined keys and deep-serializes the rest', () => {
    expect(serialize({ a: 1, b: null, c: undefined, d: { e: 2 } }))
      .toEqual({ a: 1, d: { e: 2 } });
  });
});
```

- [ ] **Step 2: Run it (expect green)**

Run:
```bash
npm test
```
Expected: PASS — `objectUtils.pull` and `objectUtils.serialize` suites all green. (This is a characterization test: the code already exists, so a passing run proves Vitest loads real CJS app code on Node 20.)

- [ ] **Step 3: Prove the harness actually fails on red**

Temporarily change the first assertion's expected value to `{ a: 'WRONG' }` and run `npm test`.
Expected: FAIL on `objectUtils.pull › copies fields flagged true/1`. Then revert the change and re-run — back to green. (Confirms the runner reports failures, so CI gating is real.)

- [ ] **Step 4: Commit**

```bash
git add test/unit/objectUtils.test.js
git commit -m "test: add objectUtils unit tests (first Vitest suite)"
```

---

### Task 4: GitHub Actions CI (Node 20)

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `npm test` (Task 2), Node 20 pin (Task 1).
- Produces: CI that installs deps on Node 20 and runs the Vitest suite on every push and PR — the green gate every later slice relies on.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/test.yml`:
```yaml
name: tests

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install dependencies
        run: npm install --legacy-peer-deps
      - name: Run tests
        run: npm test
```
(Uses `npm install --legacy-peer-deps` to match the Dockerfile, which avoids a lockfile-vs-peer-deps mismatch on the first Node 20 run. Switch to `npm ci` in a later slice once the lockfile is regenerated on Node 20.)

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run Vitest on Node 20 (push + PR)"
git push -u origin tests/rebuild
```

- [ ] **Step 3: Verify the run is green**

Run:
```bash
gh run list --branch tests/rebuild --limit 1
gh run watch
```
Expected: the `tests` workflow completes with conclusion `success` on Node 20.

---

## Self-Review

- **Spec coverage (Slice 1 scope):** Node 20 (Task 1) ✓ · Vitest framework (Task 2) ✓ · one trivial/real green test (Task 3) ✓ · GitHub Actions CI (Task 4) ✓ · `npm install` validated on Node 20 (Task 4 CI) ✓. Full app-boot smoke is deferred: it requires the global setup (app.js + db + redis-mock) which is ported in Slice 2; Node-20 app boot is already proven in production by the fork.
- **Backend-neutral / no-migration:** no runtime code touched; mongoose untouched. ✓
- **Placeholders:** none — every step has concrete files, code, and commands.
- **Type consistency:** `pull`/`serialize` signatures match `lib/util/objectUtils.js`; `npm test` → `vitest run` is consistent across Tasks 2–4.

## Out of scope (later slices)

- Slice 2: port high-value mocha tests to Vitest + remove mocha/chai/sinon + port the app-boot/db setup; switch CI to `npm ci`.
- Slice 3: backend contract suite (Mongo via `mongodb-memory-server`, then Firestore via emulator in the fork).
- Slice 4: integration flows + coverage threshold + ratchet.
