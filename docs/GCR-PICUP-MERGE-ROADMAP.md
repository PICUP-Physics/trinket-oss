# gcr → picup/main Merge Roadmap

> Planning doc; lives on `gcr-firebase` for now, merges upstream with the other
> ops docs at Stage 6.
> Snapshot date: 2026-07-04. Update the divergence numbers before acting — they drift.

## Goal

**One `main` for both systems.** Bring the gcr fork's portable work back to
`picup/main` so any deploy — Mongo (picup) or Firestore (gcr) — has confidence
things work, **without** forcing a data migration or breaking picup's Mongo
default. Endgame: histories converge, `gcr-firebase` is deleted, and the
mandi/uindy deploy worktrees track `main` directly (per-deploy config stays in
gitignored overlays, exactly as today).

## Operating rhythm: port up, sync down (decided 2026-07-04)

Content-porting alone doesn't converge histories — it just makes two lines with
similar content. So after **every** stage lands upstream:

1. `git merge picup/main` into `gcr-firebase`, resolving shared files to
   **upstream's** version (review tweaks made during the PR win).
2. FF-merge into the deploy worktrees and deploy to mandi/uindy.

Effects: gcr runs the *merged* code in production (real-world validation
upstream can't get any other way), review-time drift can't accumulate, and the
divergence count ratchets **down** after every stage instead of holding until a
big-bang finish. By the final stage the convergence merge is near-empty.
Down-syncs start only after Stage 0 (the 5-PR hold still applies).

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

## Strategy: staged themed PRs + down-sync, not one monster

Routes considered (2026-07-04):

- **A. Monster merge** — one ~20k-line PR. Converges history immediately but is
  unreviewable, risks clobbering carried patches, and ships untested
  Firestore/LTI code to picup in one shot. Rejected.
- **B. Staged themed PRs only** — reviewable, but histories never converge and
  review-time edits upstream drift from what gcr runs in prod. Rejected as
  incomplete.
- **C. Staged PRs + down-sync after every stage** — B's reviewability plus
  progressive convergence and prod validation of the merged code. **Chosen.**

Known cost of staging: the 277 commits weren't authored in neat buckets, so
each stage is *constructed* from the diff, not cherry-picked — real extraction
labor, same as the PR-validation march (which worked).

**Portable → picup/main, in order (each stage ends with a down-sync + deploy):**

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
- **Stage 6 — Ops docs + deploy/seed scripts upstream** (decided 2026-07-04:
  upstream, not a separate repo). Relocate as `docs/deploy/gcr/` +
  `scripts/` — inert files, no runtime effect. Ask Andrew's blessing when the
  time comes; fallback is a small separate deploy-tools repo, which still
  achieves single-main for the app code.
- **Stage 7 — Convergence merge + dissolve the fork.** Final
  `gcr-firebase → picup/main` merge PR whose content diff should be ~empty
  (like PR #37 did for trinketapp — after which syncs became trivial). Then
  delete `gcr-firebase`; deploy worktrees track `main`; the only per-deploy
  difference left is the gitignored overlay files.

**Never in git anywhere (gitignored, both repos):** `.env`,
`local-production.yaml`, any per-deploy secrets. (These were previously listed
as "fork-only" along with ops docs — reclassified: only *secrets* stay out of
git; everything else eventually merges at Stage 6.)

## Known conflict zones

- **base.html New-Trinket menu** — both forks restructured it differently (gcr
  consolidated helper + single-type button; picup python3-canonical curation).
  **Combine both** at whichever stage touches views (Stage 4/5).
- **Carried patches** — gcr prod cherry-picked some fixes ahead of upstream
  merge; verify none are lost when a stage's bucket lands (e.g. PR #20 upload
  fix). Cross-check against `project_fork_carried_patches`.
- **picup's 126 upstream commits** — the trinketapp sync (#37) changed shared
  files; each stage merges against current `picup/main`, not the old base.

## Divergence ratchet

Track the numbers here after each down-sync; they should only go down.

| Date | Stage completed | gcr ahead | picup ahead |
|---|---|---|---|
| 2026-07-04 | (baseline) | 277 | 126 |

## Immediate next actions

1. Get the 5 open PRs reviewed → merged (Stage 0).
2. First down-sync: merge picup/main into gcr-firebase (picks up #36, #37,
   #30/#22 etc. that are already upstream), deploy, record the ratchet.
3. Then draft the Stage 1 test-rebuild → picup PR.
4. Re-measure divergence before Stage 2 (it will have shrunk).
