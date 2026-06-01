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
