# Test Rebuild — Slice 2d: Cleanup (delete legacy mocha, remove deps, npm ci) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the now-dead legacy mocha/chai/sinon/supertest test files, helpers, and devDeps, and switch CI to `npm ci` — leaving a clean, Vitest-only test branch ready for the final review + PR to picup/main.

**Architecture:** All legacy mocha files are `*.js` (no `.test.js` suffix), so Vitest's `include: ['test/**/*.test.js']` glob already ignores them — deleting them does NOT change the test run (it stays 122 passed / 15 skipped / 0 failed). Then drop the unused devDeps and flip CI from `npm install --legacy-peer-deps` to `npm ci`.

**Tech Stack:** Vitest, npm, GitHub Actions.

## Global Constraints

- **Backend-neutral / no migration:** change only `test/**`, `package.json`/`package-lock.json`, and `.github/workflows/test.yml`. No `lib/` runtime, no `config.db.backend`.
- **Suite stays green:** after each task, `npm test` must still report **122 passed / 15 skipped / 0 failed** (deletions remove only files Vitest never ran). The 15 skips are intentional `TODO(slice-2c-b)` findings — do NOT touch them here.
- **KEEP (do not delete):** `test/helpers/defaults.js` (imported by 11 test files), `test/helpers/flow.cjs` (imported by 10), `test/helpers/vitest-setup.cjs`, `test/helpers/mongo-global.mjs` (the active harness), and all `test/**/*.test.js`.
- **CI is the gate:** the final task is done only when the CI run for the new HEAD commit concludes `success` (confirm via the HEAD sha, not the latest run).

---

### Task 1: Delete the legacy mocha test files

**Files (delete all):**
- `test/setup.js`
- `test/lib/api/admin.js`, `course.js`, `files.js`, `forgot_pass.js`, `index.js`, `legacy.js`, `login.js`, `logout.js`, `profile.js`, `registration.js`, `trinket.js`
- `test/lib/models/course.js`, `lesson.js`, `trinket.js`, `user.js`
- `test/lib/models/plugins/paginate.js`, `roles.js`
- `test/lib/util/user.js`

- [ ] **Step 1: Delete them**

```bash
cd /Users/steve/Development/glow-repos/trinket-tests
git rm test/setup.js \
  test/lib/api/admin.js test/lib/api/course.js test/lib/api/files.js test/lib/api/forgot_pass.js \
  test/lib/api/index.js test/lib/api/legacy.js test/lib/api/login.js test/lib/api/logout.js \
  test/lib/api/profile.js test/lib/api/registration.js test/lib/api/trinket.js \
  test/lib/models/course.js test/lib/models/lesson.js test/lib/models/trinket.js test/lib/models/user.js \
  test/lib/models/plugins/paginate.js test/lib/models/plugins/roles.js \
  test/lib/util/user.js
```

- [ ] **Step 2: Suite unchanged + green**

Run (network for mongod binary on cold cache → `dangerouslyDisableSandbox: true`): `npm test`
Expected: **122 passed / 15 skipped / 0 failed** (unchanged — these files were never matched by the Vitest glob). If any `.test.js` now errors with "Cannot find module", a ported test still imported a legacy file — restore that one file and report it.

- [ ] **Step 3: Commit**

```bash
git commit -m "test: remove legacy mocha test files (ported to Vitest)"
```

---

### Task 2: Delete the legacy test helpers

**Files:** delete the legacy helpers; KEEP `defaults.js`, `flow.cjs`, `vitest-setup.cjs`, `mongo-global.mjs`.

- [ ] **Step 1: Verify they're unreferenced**

```bash
grep -rnE "helpers/(flow'|flow\"|db|catbox-redis|mail|queue|store)" test lib | grep -v "flow.cjs"
```
Expected: no output (the only referencing files were the legacy tests deleted in Task 1). If anything prints, do NOT delete that helper — report it.

- [ ] **Step 2: Delete**

```bash
git rm test/helpers/flow.js test/helpers/db.js test/helpers/catbox-redis.js \
  test/helpers/mail.js test/helpers/queue.js test/helpers/store.js
```

- [ ] **Step 3: Suite green**

Run: `npm test` → expect **122 / 15 / 0**.

- [ ] **Step 4: Commit**

```bash
git commit -m "test: remove legacy test helpers (replaced by flow.cjs + Vitest harness)"
```

---

### Task 3: Remove the legacy devDependencies

**Files:** `package.json`, `package-lock.json`

Remove: `chai`, `chai-as-promised`, `mocha`, `sinon`, `sinon-chai`, `supertest` — and `redis-mock` (replaced by the in-memory client in `vitest-setup.cjs`). KEEP: `vitest`, `@vitest/coverage-v8`, `mongodb-memory-server`, `form-data`.

- [ ] **Step 1: Confirm `redis-mock` is unused**

```bash
grep -rn "redis-mock" test lib
```
Expected: no output. (If it prints, drop `redis-mock` from the uninstall list and report it.)

- [ ] **Step 2: Uninstall (updates package.json + lockfile together)**

```bash
npm uninstall --save-dev --legacy-peer-deps chai chai-as-promised mocha sinon sinon-chai supertest redis-mock
```
(Network → `dangerouslyDisableSandbox: true`.)

- [ ] **Step 3: Suite still green (nothing depended on the removed deps)**

Run: `npm test` → expect **122 / 15 / 0**. If a `.test.js` now fails to import `chai`/`sinon`/`supertest`, that file wasn't fully ported — report it (do not re-add the dep silently).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove legacy test devDeps (mocha/chai/sinon/supertest/redis-mock)"
```

---

### Task 4: Switch CI to `npm ci`

**Files:** `.github/workflows/test.yml`

- [ ] **Step 1: Edit the install step**

Change line 18 from:
```yaml
        run: npm install --legacy-peer-deps
```
to:
```yaml
        run: npm ci --legacy-peer-deps
```
(`npm ci` installs exactly from the now-in-sync lockfile — deterministic and faster. `--legacy-peer-deps` keeps the same peer-resolution mode the project has used since Slice 1.)

- [ ] **Step 2: Sanity-check `npm ci` works locally against the lockfile**

Run (network → `dangerouslyDisableSandbox: true`): `npm ci --legacy-peer-deps`
Expected: clean install, no `EUSAGE`/lockfile-out-of-sync error. If it errors that the lockfile is out of sync, run `npm install --legacy-peer-deps` to resync, `git add package-lock.json`, and amend Task 3's commit (or add a fixup commit), then retry.

- [ ] **Step 3: Commit + push**

```bash
git add .github/workflows/test.yml
git commit -m "ci: install with npm ci (deterministic, lockfile now in sync)"
git push origin tests/rebuild
```
(Network → `dangerouslyDisableSandbox: true`.)

- [ ] **Step 4: Confirm CI green for the new HEAD commit (the gate)**

```bash
HEAD=$(git rev-parse HEAD)
RID=$(gh run list --branch tests/rebuild --limit 10 --json databaseId,headSha -q "[.[] | select(.headSha==\"$HEAD\")][0].databaseId")
gh run watch "$RID" --exit-status
```
(Network → `dangerouslyDisableSandbox: true`.) Expected: conclusion `success` — and critically, the `npm ci` step must succeed (proves the lockfile is committed and consistent). Iterate until the HEAD run is green.

- [ ] **Step 5: Report** total suite counts, the CI run id + conclusion, and that `npm ci` (not `npm install`) ran.

---

## Self-Review

- **Spec coverage (2d):** legacy mocha files deleted (Task 1) ✓; legacy helpers deleted (Task 2) ✓; legacy devDeps removed (Task 3) ✓; CI on `npm ci` (Task 4) ✓.
- **Backend-neutral / no migration:** only `test/**`, package manifests, and CI; `lib/` untouched. ✓
- **Placeholders:** none — exact file lists, exact dep names, exact commands. Each task re-verifies the suite stays 122/15/0, and Task 4 gates on a green CI run for HEAD.
- **No mocha.opts / .mocharc:** recon found none (the `"test": "test"` at package.json:7 is `directories.test` metadata, not a mocha config — leave it). The `"test": "vitest run"` script is already correct.

## After 2d — out of scope here

- **Final whole-branch review** (most-capable model) over the full `tests/rebuild` diff vs its merge base: scrutinize the accumulated findings — the 15 `TODO(slice-2c-b)` skips (which to convert to assert current behavior vs investigate), the trinket `shortCode 10→12` value change, and overall test quality.
- **PR(s) to picup/main** (backend-neutral, Node 20 + Vitest). The Firestore contract leg (Slice 3) stays in the fork.
