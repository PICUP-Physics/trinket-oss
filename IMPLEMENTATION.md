# Trinket Firestore Adapter — Implementation Log

## Application stack

Server framework: Hapi 20, booted from [app.js](app.js). Plain CommonJS — no
TypeScript or bundler for app code (Vite is used only to compile SCSS).

- Templates: Nunjucks in [lib/views/](lib/views/), rendered via `@hapi/vision`.
- Static assets: [public/](public/) served via `@hapi/inert`.
- Auth: Passport (Google OAuth + local strategy) with `@hapi/yar` cookie
  sessions. Session cache backend is selected by `config.app.plugins.session.cache.backend`
  (`memory` / `mongoose` / `firestore`).
- Data: Mongoose-shaped models in [lib/models/](lib/models/) talking through a
  backend factory ([lib/db/backend-factory.js](lib/db/backend-factory.js)) that
  swaps between Mongoose and Firestore at boot based on `config.db.backend`.
- Validation: Joi schemas declared on routes (not in controllers).

### Routing

Routes are configured centrally, not per-controller. The full URL surface
lives in [config/routes.js](config/routes.js) as an array of compact specs:

```js
{ route: 'PUT /api/users/{userId} users.updateProfile',
  config: { auth: 'session', validate: { payload: {...} } } }
```

The `route` string encodes method + path + `controller.handlerName`. At boot,
[app.js](app.js) registers them all with one `server.route(config.routes)` call.

Controllers in [lib/controllers/](lib/controllers/) export bare handler
functions keyed by name (e.g. `module.exports = { createCourse, getCourse, ... }`).
They know nothing about URLs, auth requirements, or payload validation — those
are declared in the routes table. To add or trace an endpoint, expect to edit
both files: [config/routes.js](config/routes.js) for the URL contract and the
matching controller for the handler logic.

## Architecture decision

**Option A**: Firestore backend translates MongoDB-style query syntax internally.
Existing class methods in all model files are unchanged. The backend factory
selects the adapter at boot time via `config.db.backend`.

## Slices completed

### Slice 1 — Backend factory scaffold (commit d754216)
- `lib/db/backend-factory.js` — singleton that returns `mongoose-backend` or
  `firestore-backend` based on `config.db.backend` ('mongoose' is default)
- `lib/db/mongoose-backend.js` — thin pass-through to `mongoose.model()`
- `lib/models/model.js` — changed one line: `mongoose.model(...)` →
  `backend.getBackend().createModel(...)`
- `config/test.yaml` — added `redis.enabled: false` (uses in-memory fallback)
- Deleted `test/helpers/catbox-redis.js` (obsolete — sessions use catbox-mongoose)

### Slice 2 — Full Firestore adapter (commit ba89014)
- `lib/db/firestore-backend.js` — complete implementation
- `package.json` / `package-lock.json` — `@google-cloud/firestore@8.6.0` added

## What the Firestore adapter supports

**Query translation** (MongoDB syntax → Firestore):
- `{ field: value }` → equality `==`
- `{ field: { $ne: v } }` → `!=`
- `{ field: { $in: [...] } }` → `in` for scalar fields, `array-contains-any` for
  array-typed fields (see Slice 10 — Mongo array semantics)
- `{ field: { $gt/$lt/$gte/$lte: v } }` → range comparisons
- `{ field: { $exists: true/false } }` → `!= null` / `== null`
- `{ $or: [...] }` → `Filter.or()` (Firestore Native mode only)

**Update translation**:
- `{ $set: { f: v } }` → field update
- `{ $inc: { f: n } }` → `FieldValue.increment(n)`
- `{ $push: { f: v } }` → `FieldValue.arrayUnion(v)`
- `{ $push: { f: { $each: [...] } } }` → `FieldValue.arrayUnion(...values)`
- `{ $pull: { f: v } }` → `FieldValue.arrayRemove(v)`
- `{ $addToSet: { f: v } }` → `FieldValue.arrayUnion(v)`

**Mongoose-compatible API surface**:
- `Model.find(filter).sort().limit().skip().exec()`
- `Model.findOne(filter)`, `Model.findById(id)`
- `Model.findByIdAndUpdate(id, update, options)`
- `Model.deleteOne(filter)`, `Model.deleteMany(filter)`
- `Model.count(filter)`
- `Model.aggregate()` — stub returning `[]` (needs JS-level overrides per model)
- `new Model(data)` → `FirestoreDocument` with field access, `save()`, `remove()`
- `doc.save()` — runs Mongoose `pre('save', fn)` hooks before writing
- `doc.isModified(field)`, `doc.markModified(field)`, `doc.set()`, `doc.get()`
- `schema.methods` — attached to loaded document instances
- Collection name: `modelName.toLowerCase() + 's'` (e.g. User → users)

**Stubbed / not yet implemented**:
- `aggregate()` — returns `[]`; models using it need per-method JS overrides
- `populate()` — no-op; callers do N+1 explicitly (acceptable for this use case)

### Slice 3 — Firestore session store (current branch)
- `lib/util/catbox-firestore.js` — catbox engine backed by Firestore `sessions`
  collection. Values are JSON-serialized; TTL is enforced client-side on `get()`.
- `config/db.js` — skips MongoDB `connect()` when `db.backend !== 'mongoose'`.
- `app.js` — reads `config.db.backend` at startup and selects `catbox-firestore`
  or `catbox-mongoose` accordingly (backwards-compatible).

### Slice 4 — Firestore slug stores (current branch)
- `lib/util/store/firestore-client.js` — Firestore-backed list client
  implementing `lIndex`, `lPush`, `lRem`, `lRange`, `rPush`, `exists`
  (all backed by `store_lists` collection, transactional read-modify-write).
- `lib/util/store.js` — added `_getStoreClient` that routes `trinkets()`,
  `courses()`, and `users()` sub-stores through `firestore-client` when
  `db.backend === 'firestore'`. Base `get/set/del/expire` (temp tokens) keep
  using in-memory fallback (unchanged).
- `test/smoke-firestore-sessions.js` — 16-case smoke test covering both modules.

### Slice 5 — Cloud Run deployment prep (commit fe21eea)
- `config/cloudrun.yaml` — replaced MongoDB URI placeholder with
  `db.backend: firestore` and `db.redis.enabled: false`. `db.firestore.projectId`
  is intentionally absent; the Firestore SDK reads `GOOGLE_CLOUD_PROJECT`
  automatically on Cloud Run. `app.url.hostname` is injected at runtime via
  `NODE_CONFIG` by `deploy.sh`.
- `deploy.sh` — end-to-end deploy script (see "Deploying to Cloud Run" below).
- `.dockerignore` — added `node_modules`, `config/local.yaml` (and variants),
  `.env`, `*.log` to prevent secrets and build artifacts from entering the image.

### Slice 6 — GCS snapshot storage (commit 9f8bf21)
- `lib/util/storage.js` — new module wrapping `@google-cloud/storage` v7.
  `uploadSnapshot(filename, buffer)` saves PNG to the `trinket-snapshots` GCS
  bucket. `snapshotUrl()` checks `STORAGE_EMULATOR_HOST`; if set it returns the
  Firebase Storage emulator URL using `STORAGE_PUBLIC_HOST` (browser-facing host
  may differ from the container-internal upload host).
- `lib/controllers/trinket.js` — snapshot handler now calls
  `StorageUtil.uploadSnapshot()` instead of S3. Fixed `new Buffer()` →
  `Buffer.from()`.
- `config/default.yaml` — added `gcs.buckets.snapshots.{name,host}`.
- `firebase.json` / `storage.rules` — added storage emulator config with
  permissive dev rules.
- `docker-compose.yml` — firebase service now starts `--only auth,firestore,storage`.
- (Previously `emulator.sh` and `dev-docker.sh`; both removed — `docker compose up` supersedes them.)
  `host.docker.internal:9199` for container uploads; passes
  `STORAGE_PUBLIC_HOST=http://localhost:9199` for browser-facing URLs.

**Production**: set `gcs.buckets.snapshots.name` to the real GCS bucket name;
the SDK uses Application Default Credentials automatically on Cloud Run.

### Slice 7 — WebVPython-only mode + Google OAuth (commit 9f8bf21)
- `config/default.yaml` — `features.trinkets`: `glowscript: true`, all others
  `false`.
- `docker-compose.yml` — `NODE_CONFIG` includes `features.trinkets` overrides
  and `app.auth.google` credentials sourced from `.env` via environment variables.
  This avoids putting secrets in `config/local.yaml` (which must never be
  committed).
- `public-components` updated to v1.1.0 (includes Ace editor fix; removed
  manual workaround from Dockerfile).

### Slice 8 — Legacy import feature (commits 1e161b7, ee01ab0, 4168551, 64c4d04)

Supports users migrating from the old MongoDB-based trinket server. Two API
endpoints + a UI at `/account/import`.

**Schema changes**:
- `lib/models/trinket.js` — `legacyShortCode: { type: String, sparse index }`
- `lib/models/material.js` — `unresolvedLegacyRefs: [String]`

**`POST /api/imports/trinkets`** (multipart, `file` field, up to 50 MB):
- Accepts the `trinket-export-*.zip` produced by the old server's bulk-export
  feature.
- Zip structure: `manifest.json` + `{lang}/{name}_{shortCode}/metadata.json` +
  code files.
- For each trinket in the manifest: skips if `legacyShortCode` already exists
  (idempotent); otherwise creates a new `Trinket` doc with `legacyShortCode` set
  to the old shortCode and a freshly generated `shortCode`.
- After import, scans `Material` docs whose `unresolvedLegacyRefs` contain any of
  the newly imported shortCodes, rewrites the `trinket.io/embed` URLs to local
  server URLs, and clears the resolved entries.
- Returns `{ imported, skipped, failed, mapping: {oldCode → newCode}, patched }`.

**`POST /api/imports/course`** (multipart, `file` + optional `name` + optional
`force`, up to 50 MB):
- Accepts the `*-md.zip` course export from the old server.
- Zip structure: `chapter-{N}/{filename}.md` files containing markdown with
  `<iframe src="https://trinket.io/embed/{lang}/{shortCode}">` embeds.
- Validates all embed shortCodes against `legacyShortCode` in the DB.
- Without `force`: if any refs are unresolved, returns
  `{ status: 'missing_refs', missing: [...] }` so the caller can import
  the missing trinkets first.
- With `force=true`: creates the full Course → Lessons → Materials hierarchy,
  rewrites resolved URLs to `{app.url}/embed/{lang}/{newShortCode}`, and stores
  unresolved old shortCodes in `material.unresolvedLegacyRefs` for later
  auto-patching.
- Returns `{ status: 'ok', courseId, slug, ownerSlug, url }`.

**UI** (`lib/views/users/includes/import.html`):
- Added "Import" to the account settings sidebar (`lib/views/users/account.html`).
- Step 1: file picker → trinket import, shows result table.
- Step 2: file picker + optional course name → course import; on `missing_refs`
  shows the unresolved shortCodes and an "Import anyway" button that re-submits
  with `force=true`.
- Plain jQuery + Foundation CSS; no new dependencies.

## Smoke test results (Firestore emulator, Slices 1–2)

All tested against `FIRESTORE_EMULATOR_HOST=localhost:8080`:
- save + findById round-trip ✓
- findOne with equality filter ✓
- find + sort + limit ✓
- count ✓
- findByIdAndUpdate with $set ✓
- findByIdAndUpdate with $inc ✓
- deleteOne ✓
- $or query ✓
- pre-save hooks (field mutation persisted) ✓
- schema.methods attached to loaded instances ✓
- Full app boot with Firestore backend ✓
- GET / → 200, GET /login → 200 ✓
- GET /api/trinkets → 401 (auth check working) ✓

## Smoke test results (Slices 3–4)

`test/smoke-firestore-sessions.js` — 16 cases, all green:
- catbox-firestore: start/stop, get/set round-trip, TTL expiry, drop ✓
- firestore-client: lIndex, lPush, lRange, rPush, lRem, exists, negative index ✓

## MongoDB elimination status

**Complete** when `db.backend: firestore` is set in config. With that config:
- `config/db.js` skips the Mongoose/MongoDB connection.
- Sessions use `catbox-firestore` (Firestore `sessions` collection).
- Slug stores (userStore, courseStore, trinketStore) use `firestore-client`.
- Model layer uses `firestore-backend.js` (unchanged from Slice 2).
- The `test-mongo` Docker container is no longer needed.

The `catbox-mongoose.js` file is retained for backwards compatibility when
`db.backend: mongoose` (the default).

## Deferred: dependency upgrades

Several direct dependencies are deprecated and should be updated, but none block
Cloud Run operation. Address in a future pass:

| Package | Current | Action |
|---|---|---|
| `node-uuid` | 1.4.x | Replace with `uuid` (drop-in) |
| `highlight.js` | 9.x | Upgrade to 11.x (API changed) |
| `nodemailer` | 2.x | Upgrade to 6.x (API rewrote) |
| `request` | 2.x | Replace with `node-fetch` or `got` (archived) |
| `sinon` | 1.x | Upgrade to current (dev only) |
| `supertest` | 0.8.x | Upgrade to 7.x (dev only) |

Transitive deprecations (`tar`, `glob`, `rimraf`, etc.) will resolve when the
packages above are upgraded.

## What still runs in-memory (not yet persisted to Firestore)

The base `Store.get/set/del/expire` methods in `lib/util/store.js` are used for
temporary tokens: password reset, email verification, account activation. They
fall through to `InMemoryClient` when Redis is disabled. On Cloud Run (scales to
zero), these tokens will be lost on restart. A future slice can back them with
Firestore as well, but it is low priority (users can simply re-request a reset).

## Local development setup

### 1. Prerequisites

- Docker Desktop (Mac/Windows) or Docker Engine (Linux)
- `.env` file with `SESSION_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### 2. Start everything

```bash
# First run only — builds the Firebase emulator image (~2-3 min, ~500 MB)
docker compose build firebase

# Start emulators + app together
docker compose up
```

The `firebase` service starts the Auth, Firestore, and Storage emulators.
The `app` service waits for the emulator health check before starting.

- App: http://localhost:3001
- Emulator UI: http://localhost:4000

### 3. Smoke tests

```bash
# Unit/integration smoke test (sessions + slug stores):
FIRESTORE_EMULATOR_HOST=localhost:8080 GOOGLE_CLOUD_PROJECT=demo-trinket \
NODE_ENV=development node test/smoke-firestore-sessions.js

# HTTP smoke test (app must be running):
curl http://localhost:3001/          # → 200
curl http://localhost:3001/login     # → 200
curl http://localhost:3001/api/trinkets  # → 401
```

## Deploying to Cloud Run

### Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- A GCP project with billing enabled

### Run the script

```bash
export GOOGLE_CLOUD_PROJECT=your-gcp-project-id
./deploy-cloudrun.sh
```

The script handles everything in order:
1. Enables required APIs (Cloud Run, Cloud Build, Secret Manager, Firestore)
2. Creates the Firestore Native database if it doesn't exist
3. Creates the `trinket-session-password` secret in Secret Manager (prompts
   for the password on first run)
4. Grants IAM roles to the Cloud Run default compute SA:
   `secretmanager.secretAccessor` and `datastore.user`
5. Builds the container image via Cloud Build (no local Docker required)
6. Deploys to Cloud Run with `NODE_ENV=production`, `NODE_APP_INSTANCE=cloudrun`,
   `GOOGLE_CLOUD_PROJECT`, and `SESSION_PASSWORD` from Secret Manager
7. Patches `NODE_CONFIG` with the service hostname after the first deploy

### Optional overrides

```bash
export GOOGLE_CLOUD_REGION=us-east1    # default: us-central1
export SERVICE_NAME=trinket-staging    # default: trinket
export MEMORY=1Gi                      # default: 512Mi
export MAX_INSTANCES=20                # default: 10
```

### Environment variables set on the Cloud Run service

| Variable | Source | Purpose |
|---|---|---|
| `NODE_ENV` | deploy.sh | `production` — disables dev logging, enables prod Hapi config |
| `NODE_APP_INSTANCE` | deploy.sh | `cloudrun` — loads `config/cloudrun.yaml` via node-config |
| `GOOGLE_CLOUD_PROJECT` | deploy.sh | GCP project ID for Firestore SDK auto-detection |
| `NODE_CONFIG` | deploy.sh | JSON override injecting `app.url.hostname` |
| `SESSION_PASSWORD` | Secret Manager | Cookie signing key (32+ chars) |
| `PORT` | Cloud Run | Set automatically; app.js reads it |

---

## Future considerations

### Export/import folder structure with trinkets

When exporting trinkets (the `trinket-export-*.zip` bulk export), also serialize
the user's folder hierarchy so it can be reconstructed on import.

**Approach:**
- Add `folders.json` to the export zip alongside `manifest.json`, containing the
  folder tree (id, name, parent, slug) and each folder's trinket membership list
  (by shortCode, not by id — same as the manifest uses).
- On import, recreate folders in parent-first order (sort by depth), then assign
  imported trinkets to their folders using the old→new shortCode mapping already
  built during `importTrinkets`.

**Complexity:** moderate. The `Folder` model already exists. Main wrinkle is
nested folders requiring ordered creation; everything else follows the existing
trinket import pattern. No schema changes needed.

### WASM Python trinket type (Pyodide)

Idea: add a new trinket `lang` (e.g. `python-wasm` or `pyodide`) that runs real
CPython in the browser via Pyodide, alongside the existing Skulpt-backed
`python` and the server-side `python3`. Motivation is to get real-CPython
semantics (numpy, pandas, matplotlib) without operating the `python3` sandbox
container — which fits the GCR/Firestore direction of eliminating self-hosted
backend services.

How the trinket-type system is wired (mostly declarative):

- [config/constants.js](config/constants.js) — `trinketLangs` enum (used by
  the Mongoose schema on `Trinket.lang`).
- [config/default.yaml](config/default.yaml) — `features.trinkets` toggle plus
  capability lists (`autorun`, `outputOnly`, `toggleCode`, `downloadable`,
  `configurable`, `runOption`, ...).
- [lib/views/embed/{lang}.html](lib/views/embed/) — the embed iframe template,
  extends `embed/base.html`.
- [lib/views/trinket/{lang}/](lib/views/trinket/) — the create/edit page
  templates.
- [public/js/embed/{lang}.js](public/js/embed/) — the runtime bridge that
  wires the editor, console, run button to the sandbox.

The config plumbing and templates are mechanical (~1 day). The hard part is
the runtime bridge JS — for Pyodide that means loading it in a Web Worker,
wiring stdin/stdout/stderr to the existing console UI, deciding what to do
about `turtle` (Skulpt has a DOM-canvas implementation; Pyodide does not),
and asset/image handling (Emscripten MEMFS vs Skulpt's FS shim).

Rough effort tiers:

| Scope | Estimate |
|---|---|
| Skeleton: prints to console, errors show. No graphics, turtle, input(), assets. | ~1 day |
| Useful for non-graphics work: stop button, input(), matplotlib. | ~3–5 days |
| Feature parity with current Skulpt Python (turtle, assets, unittests). | ~2–4 weeks |

`features.trinkets` already gates visibility per-deployment, so a new type can
ship disabled and be enabled per-environment.

---

### Slice 9 — Export/import round-trip (cherry-picked 2026-06-02)

Cherry-picked from upstream PR branches — all applied cleanly with no conflicts.

**Export side** (from `origin/feature/export-embedded-assets`):
- `af64ed8` — Embed S3/GCS assets in course export zip (`lib/controllers/courses.js`, `lib/util/file.js`, `lib/models/file.js`)
- `104c2ec` — Include material type and assignment trinket metadata in `course.json`
- `678ed25` — Bundle referenced trinkets in course export zip

**Import side** (from `origin/feature/course-import`):
- `35b6e8c` — Prefer zip-embedded assets over trinket.io fetch on import
- `c1198d7` — Reconstruct assignment type and trinket subdocument on course import
- `e705412` — Auto-import bundled trinkets from course zip before course creation
- `abc2a21` — Allow hostname:port in iframe src whitelist (needed for local dev)

**Round-trip test** (run with `docker compose up`):
1. Export a course → zip should contain `assets/`, `trinkets/`, `course.json`
2. Import that zip → lessons, materials (pages + assignments), and trinket embed URLs should reconstruct correctly

### Slice 10 — Import refactor convergence + `$in`-on-array adapter fix (commits ecb6115, ac07d30)

Ported the upstream `imports.js` cleanup (oss commit `2a0552b`) and, in doing so,
fixed a latent Firestore query-translation bug that had silently disabled
`patchUnresolvedRefs` on this backend.

**Import controller convergence** (`ecb6115`):
- `lib/controllers/imports.js` — extracted the embed-URL rewrite regex into one
  `EMBED_URL_RE` constant; extracted the `$in` chunking loop into
  `findInChunks(items, finderFn)`; `patchUnresolvedRefs` dedups matched materials
  by `_id` after concat; `resolveAllRefs` uses a fresh `RegExp` per `exec` loop
  instead of mutating the shared global's `lastIndex`.
- `lib/models/trinket.js` — added `findByLegacyShortCode` / `findByLegacyShortCodes`
  classMethods; `lib/models/material.js` — added `findByUnresolvedLegacyRefs`.
  The controller now calls model classMethods (matching oss) instead of inline
  `this.model.find({...}).exec()`. The two forks' import controllers now differ
  only in the intentional gcr-specific slug pre-check (`findByUserAndSlug` —
  Firestore has no unique index, so duplicate slugs are checked before save
  rather than caught as E11000).

**Firestore adapter `$in`-on-array fix** (`ac07d30`):
- Mongo treats `{ arrayField: { $in: [...] } }` as "matches any element"; Firestore's
  `in` operator only does scalar equality, so `$in` on an array field matched
  **nothing**. This broke `patchUnresolvedRefs`, which queries `Material` by the
  array field `unresolvedLegacyRefs` — it never patched anything on Firestore (and
  had been wrong since the import feature landed, independent of the refactor).
- Fix: `extractArrayPaths(schema)` collects top-level array-typed paths
  (`schema.paths[name].instance === 'Array'`) into `_array_paths` on the
  lightweight modelSchema at `createModel` time; the query translator
  (`applyConstraints` + the `$or` `buildFirestoreFilter`) emits `array-contains-any`
  for `$in` on those fields, keeping `in` for scalars. `array-contains-any` caps at
  30 values, which matches the existing `CHUNK = 30` batching in `findInChunks`.

**Gotcha for future adapter work:** `createModel` does **not** retain the mongoose
Schema — it pre-extracts what it needs (`_defaults`, `_refs`, `_instance_methods`,
now `_array_paths`) into a lightweight object. Any type-aware translation logic
must likewise extract its metadata at `createModel` time; there is no `.path()` to
call at query time. The deferred `findById` + `alternateIds` adapter fix should
follow this same pattern rather than per-model overrides.

**Testing endpoints that require a session** (Firebase Auth emulator):
Auth is Firebase Auth (emulator on `:9099`, project `demo-trinket`). To get an
authenticated session without the browser OAuth flow:
1. Create a user via the emulator REST signUp:
   `POST http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`
   with `{email, password, returnSecureToken:true}` → returns `idToken` + `localId`.
2. Seed a matching trinket `User` doc (email + `firebaseUid: localId`) via a script
   run inside the container (`docker exec trinket-gcr node ...`); the script must
   keep the container's `FIRESTORE_EMULATOR_HOST` (`firebase:8080`), so use
   `process.env.X = process.env.X || 'default'`, never override.
3. `POST http://localhost:3001/api/auth/session` with `{idToken}` → sets the `session`
   cookie (`auth.session` verifies via Firebase Admin and links the user by email).
4. Use the cookie (`curl -b cookies.txt`) to hit `/api/imports/*` etc.

**Round-trip + dedup test result** (gcr stack, matches the mongo stack exactly):
90 trinkets, 12 lessons, 28/28 assignments linked, 46 materials rewritten; and a
cross-chunk `patchUnresolvedRefs` case patches the target material exactly once
(`patched: 1`) — the path that was previously broken on Firestore.

## Resume prompt

Paste this at the start of a new Claude Code session in this repo:

```
We're deploying trinket-oss to Google Cloud Run backed by Firestore Native
(no MongoDB, no Redis). Read IMPLEMENTATION.md for full context.

Branch: cloud-run-deploy. All slices are committed.

Slices completed:
- Slices 1–2: Firestore model-layer adapter (lib/db/firestore-backend.js)
- Slice 3: Firestore session store (lib/util/catbox-firestore.js)
- Slice 4: Firestore slug stores (lib/util/store/firestore-client.js)
- Slice 5: Cloud Run deploy script (deploy.sh, config/cloudrun.yaml)
- Slice 6: GCS snapshot storage (lib/util/storage.js, @google-cloud/storage v7)
- Slice 7: WebVPython-only mode; Google OAuth wired via .env → NODE_CONFIG
- Slice 8: Legacy import feature — POST /api/imports/trinkets + course,
           UI at /account/import, legacyShortCode on Trinket model,
           unresolvedLegacyRefs on Material model, auto-patch on late import
- Slice 9: Export/import round-trip cherry-picked from upstream PR branches
- Slice 10: Import refactor convergence + Firestore $in-on-array fix
            ($in on array fields → array-contains-any via _array_paths)

Local dev: docker compose up (firebase emulator + app in one command).
Rebuild app image after dependency changes: docker compose build app

Known deferred work:
- Store.get/set/del/expire (password reset tokens) still in-memory — lost on
  Cloud Run restart. Low priority; users can re-request.
- Dependency upgrades (see "Deferred" table in IMPLEMENTATION.md).

Deploy: set GOOGLE_CLOUD_PROJECT in .env and run ./deploy-cloudrun.sh
```
