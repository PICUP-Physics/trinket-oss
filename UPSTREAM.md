# Upstream PR Candidates

Changes on the `gcr-firebase` branch that fix bugs in the shared codebase and
have no GCR-specific assumptions. Each entry notes the commit, files changed,
and how to extract it for an upstream PR.

---

## 1. Fix inline image serving — `file.type` vs `file.mime` (commit `3e335c1`)

**Files:** `lib/controllers/files.js`

**Bug:** `files.download` checks `/^image/.test(request.pre.file.type)` to decide
whether to serve a file inline or as an attachment. `file.type` is the upload
category (`'embed'`, `'download'`), not the MIME type. The condition is always
false for images, so every image is served with `Content-Disposition: attachment`,
causing browsers to download rather than display it.

**Fix:** Check `file.mime` (`'image/png'`, `'image/jpeg'`, etc.) instead of
`file.type`.

**Extractability:** Single-line change, no dependencies. Cherry-pick the
`lib/controllers/files.js` hunk from `3e335c1`.

---

## 2. Fix hanging reply chain — `bytes()` missing resolver (commit `3e335c1`)

**Files:** `lib/util/routeParser.js`

**Bug:** The Hapi 4.x compatibility shim's `reply()` builder resolves the response
promise in `code()`, `header()`, `redirect()`, and `view()` — but not in `bytes()`.
Any handler ending with `.type(t).bytes(n)` (without a subsequent `.header()`) hangs
indefinitely, blocking the request.

**Fix:** Call `responseResolver(response)` at the end of `bytes()`.

**Extractability:** Single-line change. Cherry-pick the `lib/util/routeParser.js`
hunk from `3e335c1`.

---

## 3. Fix `hasCloudConfig` false-positive on HTTP hosts (commit `d4e6fc1`)

**Files:** `lib/util/component.js`, `lib/models/user.js`, `lib/models/trinket.js`

**Bug:** `hasCloudConfig` was defined as `host && !host.includes('example.com')`,
which evaluates to `true` for any non-placeholder host — including `http://localhost`
used by local S3-compatible services (MinIO, fake-gcs, etc.). This caused:
- All bower/npm frontend components (lodash, jszip, font-mfizz, …) to be fetched
  from the local storage service instead of `/components/`, crashing the embed editor
  with `_ is not defined`.
- User avatars and trinket snapshot default images to be fetched from the storage
  service, returning 501.

**Fix:** Require `https://` to qualify as a real cloud host:
`host.startsWith('https://') && !host.includes('example.com')`.

**Extractability:** Three small changes, all the same pattern. Cherry-pick
`lib/util/component.js`, `lib/models/user.js`, and `lib/models/trinket.js` hunks
from `d4e6fc1`.

---

## 4. Fix snapshot crash on unsaved GlowScript trinket (commit `d4e6fc1`)

**Files:** `public/js/embed/glowscript.js`

**Bug:** `captureAndSaveSnapshot` calls
`$('#glowscriptOutput')[0].contentWindow.postMessage(...)`. When a brand-new
trinket is saved before ever being run, the `#glowscriptOutput` iframe does not
yet exist in the DOM. `[0]` is `undefined`, throwing:
`TypeError: Cannot read properties of undefined (reading 'contentWindow')`.
The `done()` callback is never called, so `postSave()` never resolves and the UI
stays stuck in the saving state.

**Fix:** Guard with a null check — if the frame is absent, call `done()` immediately
and return.

**Extractability:** Self-contained frontend fix. Cherry-pick the
`public/js/embed/glowscript.js` hunk from `d4e6fc1`. Note: exclude the
`app.js` `.map` suppression hunk from that commit; it is dev-environment noise
filtering, not a bug fix.

---

## 5. Fix missing `File` model in `uploadUserAsset` (commit `17cc98d`)

**Files:** `lib/util/file.js`

**Bug:** `uploadUserAsset` calls `new File()` when no `replaceFile` is provided,
but `File` (`lib/models/file`) was never `require`d in `file.js`. Any call to
`uploadUserAsset` without a pre-existing file object throws
`ReferenceError: File is not defined`. This was hidden because `features.assets`
was `false` everywhere.

**Fix:** Add `File = require('../models/file')` to the requires at the top of
`lib/util/file.js`.

**Extractability:** The `lib/util/file.js` commit (`17cc98d`) also contains the
GCS storage backend addition, which is GCR-specific. Extract just the `File`
require line for upstream. Alternatively include the full `file.js` with only the
GCS additions stripped out (i.e. revert to `aws-sdk` throughout but add the
missing `require`).

---

## 6. Add missing ACE editor modes/themes (commit `d890cd3`)

**Files:** `Dockerfile` (or the `public-components.tgz` release tarball)

**Bug:** The `public-components.tgz` tarball released at `v1.1.0` includes ACE
editor core and language modes for supported trinket types (Python, HTML, Java,
etc.) but omits `theme-github.js` and `mode-markdown.js`, which the course editor
requires for markdown material editing. Both files 404, causing silent ACE
fallback (no syntax highlighting, wrong theme).

**Fix for this repo:** `Dockerfile` curls both files from cdnjs after extracting
the tarball.

**Upstream fix:** Add `theme-github.js` and `mode-markdown.js` to the
`public-components.tgz` tarball in the next release, and remove the curl workaround
from the Dockerfile. Alternatively add the curl step to the upstream Dockerfile if
the tarball is not being updated.

---

## 7. Course export/import: preserve visibility + draft status (in progress, 2026-06-18)

**Goal:** Make course export/import round-trip course-level settings and
draft/published state, so re-importing an exported course doesn't reset everything
to published/default visibility.

**The data model (verified):**
- `course.globalSettings` = `{ courseType (Public/Private/Open — UI "Course
  visibility"), contentDefault (publish/draft — UI "Default page and assignment
  visibility"), copyable }`
- `lesson.isDraft` (topic) and `material.isDraft` (page/assignment) — student
  visibility gate (`course.js` populate uses `match: { isDraft: { $ne: true } }`
  for non-editors).
- The trinket `published` boolean is vestigial in this fork (no `/sites/` route) —
  explicitly OUT of scope.

**The change:** export writes `globalSettings` + per-lesson/material `isDraft` into
the `course.json` manifest; import threads them back onto the new course/lessons/
materials. Additive + backward-compatible (old archives import as before → defaults).
Does NOT touch asset/trinket bundling (`embedAssets`/`embedTrinkets` unchanged).

**Status by repo/branch:**
- **trinket-gcr (`gcr-firebase`):** `lib/controllers/courses.js` (export) +
  `lib/controllers/imports.js` (import) — implemented and VERIFIED. Uncommitted
  (Steve to commit). Verified via in-container round-trip against the real export
  and import handlers + a legacy-archive (no fields) compat test, plus a manual UI
  round-trip.
- **trinket-oss EXPORT PR:** **OPENED — [PR #14](https://github.com/trinketapp/trinket-oss/pull/14)**
  (branch `feature/export-content-status`, commit `48f2606`, courses.js only,
  feature-only — no tests). Round-trip verified manually on the `test/minio-export`
  minio stack (assets on); reviewed solid against the schema (whitelist == full
  `globalSettings`; `isDraft` real on Lesson + Material; legacy-safe via `|| {}`).
- **trinket-oss IMPORT PR:** existing **PR #8** (`feature/course-import`). NOT yet
  updated with the import-side `imports.js` changes. Deferred — nice-to-have, not
  critical right now.
- **`test/minio-export`** (integration test branch): `test/minio-import` + the
  export change merged cleanly (merge commit `12e82fa`). Combines minio storage
  (`features.assets: true` via compose `NODE_CONFIG`) + import PR + export change —
  ≈ what trinket.io looks like with both PRs merged and assets on. Created, not yet
  run.

**Why feature-only (no automated tests in the export PR):** the oss mocha suite is
broken at HEAD (on `main` too) — `test/helpers/catbox-redis.js` requires the
unscoped `catbox-redis`, but the project moved to `@hapi/catbox-redis` and never
updated the helper, so `npm test` fails at bootstrap. A separate harness-fix PR is
the right place to add export/import tests.

**Next steps (pick up here):**
1. ~~Run the minio round-trip test.~~ DONE — verified manually (assets bundle
   alongside the new fields).
2. ~~Push + open the export PR.~~ DONE — [PR #14](https://github.com/trinketapp/trinket-oss/pull/14).
3. (Later) update import PR #8 (`feature/course-import`) with the `imports.js`
   globalSettings/isDraft threading; consider a separate PR fixing the test harness
   (`catbox-redis` → `@hapi/catbox-redis`) + adding the export/import round-trip tests.
4. Steve to commit the gcr changes (courses.js, imports.js, Dockerfile, UPSTREAM.md).

**Env note:** an ephemeral `npm install catbox-redis@4 --no-save` was run in the
running oss container to probe the harness; it perturbed that container's
`node_modules` volume (app stayed healthy). `docker compose up --build` (or dropping
the node_modules volume) restores a clean tree.
