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

## Validation plan

1. ~~Resolve all 20 → commit the trial merge~~ ✅ `015e0fe`
2. Merge `tests/rebuild` (122-test Vitest suite) into the trial branch —
   doubles as a Stage 1 conflict rehearsal.
3. Run the suite in the node:20 amd64 container (fresh `gcr-trial-nm` volume).
4. Record failures here — each failure in an auto-merged file is a finding
   for the real merge.
