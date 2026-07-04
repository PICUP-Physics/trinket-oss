# Trial Merge Research Notes — gcr-firebase → picup/main

> Research log for the rehearsal merge. Informs the real convergence
> (see GCR-PICUP-MERGE-ROADMAP.md). The trial branch itself is throwaway;
> **these notes are the deliverable.**

## Setup (2026-07-04)

- Trial branch `trial/picup-plus-prs` in a scratch worktree, built as:
  1. Branch off `picup/main` @ `a2c5a68` (post-#36/#37).
  2. Merge the 5 open PR heads — **all 5 merged clean** (they were rebased
     onto picup/main during the PR-validation march):
     `feat/configurable-fork-auth` (#29), `fix/trinket-lang-alias` (#31),
     `fix/publish-url-current-host` (#32), `fix/course-upload-dialog` (#33),
     `fix/course-editor-ace-markdown` (#34).
  3. `git merge --no-commit --no-ff gcr-firebase` → resolved → committed
     `015e0fe` (package-lock regenerated via node:20 container,
     `npm install --package-lock-only --legacy-peer-deps`).

## Headline result

**158 files changed: 99 pure adds, 58 clean auto-merges, 1 delete, 20
conflicted (~46 hunks). Full resolution took one sitting** — the 277-commit
divergence mostly collapses into brand-new files (LTI, lib/db backend,
scripts) that merge with zero friction. Residual risks are (a) silent semantic
breakage in the 58 auto-merged files — the test suite probes this — and
(b) upstream review bandwidth for a ~15k-line diff.

## Resolution log (all 20 files)

Rule of thumb that emerged: **whichever fork touched the code LAST tends to
have the superset version** — picup for import/export UX (folders,
description, Boom errors), gcr for backend-neutrality (chunked queries, slug
pre-checks, storage abstraction). "Take one side wholesale" was right for 15
of 20 files; only 5 needed real composition.

### Tier 1 — mechanical

| File | Resolution |
|---|---|
| `docker-compose.yml` | **picup's** (mongo+garage dev stack); gcr's Firebase-emulator stack preserved as new **`docker-compose.gcr.yml`** |
| `vite.config.mjs` | **combine**: picup's `loadPaths` + gcr's `quietDeps`/`silenceDeprecations` (compatible sass options) |
| `_brand-theme.scss`, `_nav.scss`, `_generic.scss` | **picup's** fallback palette — gcr rebrands via `--brand-*` custom props per deploy (the theming design working as intended) |
| `config/default.yaml` | **compose**: picup's feature values (`requireAuthToFork: false`, `pyodide: true`) + gcr's additive `courseImport` flag + gcr's additive `auth:`/`lti:` sections (inert empty defaults) + picup's `app:` branding/theme verbatim + **two NEW flags** (see Design decisions) |
| `config/api_routes.js` | **gcr's** — adds `pre: ['canCreateCourse(user)']` to course-create/import routes (see Design decisions) |
| `package-lock.json` | regenerated in container, never hand-merged |

### Tier 2 — known recipe

| File | Resolution |
|---|---|
| `lib/views/base.html` | **gcr's `{% for newTrinketTypes %}` mechanism** (single conflict hunk, exactly as predicted); curation applied in `lib/util/nunjucks.js`: `python3` relabeled **"Python"** (picup's python3-canonical), pyodide-omission comment added. nunjucks.js itself auto-merged in cleanly. |
| `lib/views/users/includes/import.html` | **gcr's** course-first layout wholesale (Ruth's UX; same blocks reordered, nothing of picup's lost) |

### Tier 3 — semantic

| File | Resolution |
|---|---|
| `lib/controllers/imports.js` (14 hunks) | **picup's throughout** (its import evolved past gcr: folderCache/linkTrinketFolder, description + instructions.md, Boom passthrough `reply(err)`, passes full `user`) **except**: hunk 1 keeps BOTH requires (`Folder` + `sluggify`), hunk 14 takes **gcr's slug pre-check** in `trySave` (Firestore has no unique indexes; Mongo E11000 catch kept as fallback — backend-neutral) |
| `lib/controllers/courses.js` (5 hunks) | picup's (equivalent-or-richer export: `.filter(Boolean)`, description in metadata.json, instructions.md) **except** hunk 3 = **gcr's chunked `findByShortCodes`** (Firestore `in`-query cap = 30; harmless batching on Mongo) |
| `lib/controllers/trinket.js` | **picup's** — gcr's side still called `verifyShortCode`, which upstream DELETED as dead code in the #37 trinketapp sync. (The "carry the shortCode fix onward to gcr" note, realized.) |
| `lib/models/trinket.js` | **gcr's** (superset: read-time repair of broken `*/avatar-default.png` snapshot URLs, no migration needed) |
| `lib/models/user.js` | **gcr's** (superset: same placeholder logic + catches stored broken default-avatar URLs) |
| `lib/util/helpers.js` | **config-gated combine** — the big one, see Design decisions |
| `lib/util/file.js` | **gcr's** — routes through `storage-backend` abstraction instead of raw `aws.S3` (works for S3 and GCS) |
| `lib/shared/trinket-markdown.js` | **gcr's** — generalizes single host to `_knownHosts` array for embed rewriting |
| `lib/views/embed/pyodide.html` | **picup's** css path (`redmond/IDE/`) — see Open items: components layout divergence |
| `public/js/embed/pyodide.js` | **gcr's** (superset: `importsMatch`/`importsPackages` generalization for the loading hint; `usesMatplotlib` semantics identical) |

## Design decisions made (need Andrew's sign-off at the real merge)

These two came out of the `helpers.js` + `api_routes.js` conflict — taking
either side wholesale breaks the other deploy family, so the single-main
answer is **two new config flags, defaults = stock/picup behavior, gcr
enables them in its overlay**:

1. **`auth.requireApprovedAccount`** (default `false`) — gates `isApproved`.
   `false`: any authenticated user can fork/create (picup today). `true`:
   account must be `approved` or site admin (gcr's approval tier).
2. **`auth.restrictCourseCreation`** (default `false`) — gates
   `userCanCreateCourse`/`canCreateCourse` (which gcr's api_routes now
   `pre`-gates on course create/copy/import — a server-side hardening picup
   currently lacks entirely). `false`: any authenticated user (picup today).
   `true`: admins + `isInstructor` only (gcr).

⚠️ **Deploy-overlay action at the real merge:** mandi/uindy
`local-production.yaml` must set both flags `true` or those deploys lose
their approval/instructor gating.

Kept from gcr without a flag (additive, inert when unconfigured):
`canInitiateLtiRegistration` (fails closed without LTI config),
`canCreateCourse` server-method registrations, `auth:`/`lti:` config sections.

## Findings for the real merge

1. All 5 open PRs merge cleanly into current picup/main — Stage 0 is friction-free.
2. **The monster is smaller than feared**: ~46 hunks, one sitting. The real
   costs are upstream review bandwidth and the 58 silent auto-merges.
3. **The #37 shortCode cleanup creates a reverse-carry**: gcr still has dead
   `verifyShortCode` code that must NOT survive (caught in trinket.js;
   watch for other remnants at down-sync).
4. **Backend-neutral patterns to preserve wherever they appear**: chunked
   `in`-queries (cap 30), slug pre-check before save (no unique indexes on
   Firestore), storage-backend abstraction instead of raw aws.S3.
5. `nunjucks.js`, `pages.js`, `home.html`, the models' Store layer — all
   auto-merged clean; the factory/backend layer really is additive.
6. picup evolved import/export past gcr (folders, instructions.md): at
   down-sync, gcr gets these FROM upstream — don't re-port gcr's older import.

## Open items

- **glowscript components layout divergence**: picup's jquery-ui css lives at
  `components/vpython-glowscript/css/redmond/IDE/`, gcr's at
  `css/redmond/` (different components pipelines: upstream tarball vs
  setup-glowscript.sh). Trial took picup's path. Unify the components
  pipeline — ties into the rehost-public-components backlog.
- The 58 auto-merged files are unaudited — test suite run is the probe.
- `docker-compose.gcr.yml` naming/placement: fine for trial; real merge may
  want `docker/` subdir or profiles.

## Stage 1 rehearsal: tests/rebuild → merged tree (2026-07-04)

Merged `tests/rebuild` into the trial branch (`8c81207`): **6 conflicts, all
trivial** — `.gitignore` (combine, +`coverage`), `.nvmrc` (identical both
sides), `Dockerfile` (keep gcr's production one with the pinned rsWVPRunner
glowscript block; tests/rebuild's minimal variant discarded), 2× modify/delete
on dead mocha files `test/setup.js` + `test/lib/models/trinket.js` (**delete**
— the Vitest rebuild deliberately replaced them; gcr's edits were to the
broken harness), package-lock (regenerated, union confirmed: vitest +
firebase-admin both present). **Stage 1 will be cheap.**

## Validation plan

1. ~~Resolve all 20 → commit the trial merge~~ ✅ `015e0fe`
2. ~~Merge `tests/rebuild` into the trial branch~~ ✅ `8191c6b` (6 trivial
   conflicts; amended — the first commit `8c81207` had accidentally staged a
   still-conflicted package-lock)
3. ~~Run the suite in the node:20 amd64 container~~ ✅ see results
4. ~~Record failures~~ ✅ below

## Test results against the merged tree (2026-07-04)

**62 pass / 73 fail / 2 skip (137).** Control: this suite is ~122-green on its
own branch against plain picup/main → the merge broke ~60-70 assertions.
**BUT the taxonomy collapses almost entirely into ONE root cause:**

### 🔴 HEADLINE FINDING: the merge silently deletes picup's local password auth

- gcr's `config/routes.js` (auto-merged in, NO conflict) replaced
  `GET /login pages.login` + **`POST /login users.login`** + the whole
  forgot-pass route block with `GET /login auth.loginPage` (Firebase login
  page). POST /login, POST /signup, forgot-pass → **404**.
- gcr's `lib/models/user.js` (its auth region auto-merged) dropped
  `encryptPassword` / `comparePassword` entirely (Firebase owns passwords).
- Cascade: registration/login flows dead → `flow.switchUser` fails →
  ~60 downstream test failures (admin/course/files/legacy/login/logout/
  profile/trinket API tests). This is EXACTLY the silent-auto-merge breakage
  class the test run was designed to expose — and the suite caught it.

**Design decision needed (the biggest of the whole merge): single main must
support BOTH auth stacks, config-selected.** Sketch: keep picup's local
email/password stack (routes, users.login, encryptPassword/comparePassword
hooks) as the default; gcr overlay switches to Firebase/Google (+ LTI). The
model hooks can stay unconditionally (no-op when no password is ever set);
the route table needs a config gate (auth.local.enabled vs auth.firebase).
Restoring + gating this is the main body of work the real merge adds beyond
what this trial already resolved.

### Secondary findings (real, smaller)

- `Trinket.findById` now queries `$or:[{_id},{shortCode}]` (gcr Store layer,
  deliberate) — 1 test asserts the old internals; update the test.
- `userByUsername` CastError: merged helper casts a username ('testing') to
  ObjectId — gcr's Store-layer lookup semantics differ from picup's
  `findByLogin`; needs a look during the real merge (affects /u/:username
  pages → sample-course page 500).
- `[instructorAuth] instructor Datastore disabled` logs on every boot —
  correct default-off behavior, good sign for the config-gating story.

### Process gotchas (for CI / the real merge)

- npm cannot re-resolve the `trinketapp/marked` git-dep from inside a git
  WORKTREE in a container (the `.git` pointer file references an unmounted
  host path; git aborts; npm falls back to ssh and fails). Workaround:
  generate package-lock in a non-git temp dir (`cp package.json /lockgen && cd
  /lockgen && npm install --package-lock-only`). Also: rehost/registry-pin
  the marked fork eventually (same theme as the components-tarball backlog).
- `npm install --package-lock-only` starting from a *valid* older lock keeps
  git deps pinned (no network git); starting from a broken/absent lock does a
  full re-resolve and hits the git-dep problem. Never hand-merge a lockfile;
  never trust a silent `>/dev/null` regen — verify with `json.load`.

## Dual-stack auth prototype (2026-07-04, trial commit `d0a233b`) — WORKS

Steve's design steer: any single deploy uses either passport/local or firebase,
NEVER both → hide the details behind a facade instead of sprinkling conditionals.

**Implemented: `config/auth_routes.js` provider facade.**
- One knob: `auth.provider: 'local' | 'firebase'` (default local = stock).
- Each provider owns its COMPLETE route surface: local = GET/POST /login,
  signup + POST /users, users.logout, forgot-pass ×4, activate-account ×2,
  `login.html` (stock form, restored); firebase = auth.loginPage rendering
  `login-firebase.html` (renamed from gcr's login.html), auth.logout,
  /auth/google + callback (passport). Session establishment for firebase stays
  POST /api/auth/session in api_routes.js (follow-up: could move into facade).
- routes.js = one line: `routes.concat(require('./auth_routes'))`. Zero auth
  conditionals anywhere else. Controllers untouched — both providers converge
  on the same cookie session + ensureSeedAdminRole/ensureInstructorFlag
  pipeline; the rest of the app only sees `request.user`.
- User model: password field + bcrypt encryptPassword/comparePassword restored
  UNCONDITIONALLY (no-op for firebase/google/lti accounts — they never set a
  password). View selection lives in the provider route entries (html key), so
  auth.loginPage needed no changes.
- `model.js findById`: gcr's raw-string `_id` $or-arm (needed for Firestore's
  string doc IDs) now fires ONLY on the firestore backend — Mongoose
  CastErrors on non-ObjectId _id, which broke every /u/{username} page on
  Mongo. Backend-aware guard via config.db.backend.

**Result: suite went 62 → 132 pass (3 fail / 2 skip of 137)** — better than
the ~122 control. The auth restoration is COMPLETE as far as the suite can see.

### Final 3 failures: NOT the storage seam (hypothesis corrected)

The FileUtil stubs worked all along (they stub the facade level —
`FileUtil.uploadMaterialFile`/`downloadMaterialFile` — which survives the
merge unchanged). The real causes, both fixed (trial commit after `d0a233b`):

1. **gcr production bug: `File.findById` override drops callbacks.** gcr's
   File model overrides the generic findById with
   `function(id){ return this.model.findById(id); }` (to skip the alternateIds
   `$or`, which the firestore backend can't express) — but it IGNORES the
   `(id, cb)` callback form. Any callback-style caller hangs forever (the 2×
   30s timeouts). Fixed: override now honors the callback like the generic.
   **Check gcr prod for other callback-form File.findById callers.**
2. **The content-disposition test encoded a picup dead-branch bug.** picup's
   `/^image/.test(file.type)` can never match (type ∈ embed/download), so
   images were ALWAYS sent as attachment. gcr's mime-based check is the fix;
   the test expectation was updated (image-mime streams inline).

### 🏁 FINAL RESULT: 135 pass / 0 fail / 2 skip — FULLY GREEN

The complete convergence (picup/main + 5 PRs + all 277 gcr commits +
tests/rebuild + dual-auth facade + the fixes above) passes the entire suite
on the Mongo/local-auth profile. The trial branch is a working candidate for
the real convergence, pending: Andrew's sign-off on the policy flags + the
5-PR gate + a firestore-profile test pass (suite currently exercises
mongoose backend only — a Firestore-emulator run of the same suite is the
one axis not yet validated).

## Bottom line for the real merge (updated)

The mechanical merge is a day's work (done here). The REAL work items are:
1. ~~Dual-stack auth restoration + config gating~~ ✅ **PROTOTYPED AND GREEN**
   (`auth_routes.js` facade above — port this design to the real merge).
2. The two policy flags (auth.requireApprovedAccount, auth.restrictCourseCreation)
   + Andrew sign-off. gcr overlays must set: both flags true +
   `auth.provider: firebase` + `db.backend: firestore`.
3. ~~userByUsername lookup~~ ✅ fixed (backend-aware findById in model.js).
4. Storage seam: 3 files.test.js failures (stub storage-backend in tests, or
   mirror the auth facade for storage). Only open code item.
5. Test updates for deliberate Store-layer changes (findById $or internals
   assertion — 1 test).
6. Components-pipeline unification (pyodide.html css path).
