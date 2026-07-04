# gcr → picup/main Merge Roadmap

> Fork-only planning doc. Lives on `gcr-firebase`, never merges upstream.
> Snapshot date: 2026-07-04. Update the divergence numbers before acting — they drift.

## Goal

Bring the gcr fork's portable work back to `picup/main` so any deploy — Mongo
(picup) or Firestore (gcr) — has confidence things work, **without** forcing a
data migration or breaking picup's Mongo default.

## Current state (2026-07-04)

- **Divergence:** `gcr-firebase` is **277 ahead** of `picup/main`; `picup/main`
  is **126 ahead** of gcr. Merge-base `6c57ecc`.
- **Backend is already pluggable** — the merge is *additive*, not a rip-out.
  `lib/db/backend-factory.js` selects between `mongoose-backend.js` and
  `firestore-backend.js`; `mongoose` is still a dependency on gcr. Firestore is
  an opt-in config choice; **Mongo stays the default** on picup. This is what
  makes a backend-neutral merge possible.
- **Upstream already caught up** (no longer part of the merge): #37 trinketapp
  sync, #36 own-authenticated-creates, #30/#25/#22/#20/#19/#18/#17/#16.
- **#28** (matplotlib WebAgg upgrade) is **CLOSED/abandoned** — drop it from the
  old hold list.

### Divergence shape (277 gcr-only commits, by theme)

| Theme | ~commits | Portable? |
|---|---|---|
| LTI | 83 | Yes (Stage 4) — mostly new files |
| course | 40 | Partly (Stage 5 UX; some fork-only) |
| docs | 33 | Mostly fork-only |
| deploy / cloudrun | 32 | **Fork-only** |
| auth | 24 | Partly (Stage 5) |
| instructor | 22 | Yes (Stage 5) |
| backend (fb/fs/ds) | ~39 | Yes (Stage 2) |
| upload | 9 | Mostly already in PR #33 |
| pyodide / matplotlib / python | 13 | Partly in PRs #31; some merged |
| snapshot | 5 | Yes (Stage 3) |
| branding | 8 | Merged (#25/#19) or small |

## Gate: 5 open PRs must land upstream first

These already carve portable fixes off the divergence and reduce later conflict
noise. Hold the big-bucket merges until they land:

- **#29** feat: configurable fork auth (anonymous forks by default)
- **#31** fix: serve python3 / pyodide interchangeably
- **#32** fix: derive published-trinket URL from current host
- **#33** fix: open upload dialog via ng-click (hard-refresh)
- **#34** fix: preload Ace markdown mode + github theme

## Strategy: staged themed PRs, not one monster

A single 277-commit merge is unreviewable and would clobber the fork's carried
patches. Peel off portable, config-gated buckets in dependency order.

**Portable → picup/main, in order:**

- **Stage 0 (in flight):** land the 5 open PRs above.
- **Stage 1 — Test rebuild** (`tests/rebuild`, already CI-green): land *first*
  so every later merge PR runs against the Vitest + backend-contract suite. The
  CI foundation.
- **Stage 2 — Backend abstraction** (`lib/db` factory + firestore backend +
  session store), config-gated, Mongo default. Stage 1's contract suite
  validates *both* backends.
- **Stage 3 — Snapshot blank guard** + small portable fixes not already in a PR.
  Independent, quick win.
- **Stage 4 — LTI subsystem** (the 83; mostly *new* files: `scripts/`,
  `ltiProvision`, LTI helpers/views), config-gated OFF by default. Depends on
  Stage 2 (provisioning writes users).
- **Stage 5 — Instructor approval + instructor-flag + course-import UX.**
  Depends on Stage 4 + Stage 2. (Instructor-flag fix already deployed to mandi;
  this stage ports it upstream.)

**Fork-only — never merge:** deploy overlays (`local-production.yaml`, cloudrun
scripts, per-deploy uindy/mandi config), gcr ops docs (UINDY-SETUP,
TESTBED-ORCHESTRATION, TRINKET-DEPLOYMENT-PLAN, compliance), `.env`.

## Known conflict zones

- **base.html New-Trinket menu** — both forks restructured it differently (gcr
  consolidated helper + single-type button; picup python3-canonical curation).
  **Combine both** at whichever stage touches views (Stage 4/5).
- **Carried patches** — gcr prod cherry-picked some fixes ahead of upstream
  merge; verify none are lost when a stage's bucket lands (e.g. PR #20 upload
  fix). Cross-check against `project_fork_carried_patches`.
- **picup's 126 upstream commits** — the trinketapp sync (#37) changed shared
  files; each stage merges against current `picup/main`, not the old base.

## Immediate next actions

1. Get the 5 open PRs reviewed → merged (Stage 0).
2. Then draft the Stage 1 test-rebuild → picup PR.
3. Re-measure divergence before Stage 2 (it will have shrunk).
