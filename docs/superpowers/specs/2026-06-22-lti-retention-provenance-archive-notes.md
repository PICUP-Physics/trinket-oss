# LTI Retention / Provenance / Archive — design notes

- **Date:** 2026-06-22
- **Status:** DESIGN NOTES — decisions pending; **do NOT implement yet.** Several core
  decisions are deliberately parked pending Steve's institutional conversations (week of
  2026-06-22). This document captures the brainstorm so the thinking survives the pause.
- **Branch:** `lti-1.3`
- **Relationship to existing work:** This is the **deferred "time-based retention expiry" v2
  layer** that `docs/superpowers/specs/2026-06-21-lti-data-deletion-design.md` named as out of
  scope. The retention sweeper drives that spec's `anonymizeUser` / deletion primitives; it does
  not re-implement them. Account-level cleanup reuses the spec's orphan check.

## Motivation (the actual driver)

The real anxiety is **not wanting to be the long-term custodian of other institutions' student
data**, and specifically the "dangling anonymized data that grows with time, costs money, and has
no value unless a faculty member wants to dig up an old document." The mechanisms below are levers
on that one concern. Anonymize-in-place cures PII but does **not** cure the cost/growth problem
(data never leaves). That tension is what the archive idea resolves.

## Decided

### 1. `retentionClass` tagging (the foundation — non-destructive)

A dedicated `User` field — `retentionClass: 'permanent' | 'expungable'`, **default `'permanent'`**
(conservative: if we're ever unsure how an account got in, we never auto-delete it).

- Set **at the authorization boundary**, where the instructor-vs-student distinction is already
  computed — not inferred after the fact from `User.source`.
  - Approved instructor at signup/login → `permanent`
  - Accepts a course invitation → `expungable`
  - LTI roster auto-provision (`lib/util/ltiProvision.js`) → `expungable`
  - Organic signup with no approval, no invite (the oss/open-signup case) → falls through to the
    default → `permanent`
- **Upgrade-only, never downgrade.** Promote `expungable → permanent` when the account becomes a
  "real owner":
  - becomes an **approved instructor** (the gcr signal), or
  - becomes a **course `_owner`** (the portable signal — oss has no instructor gate, so course
    ownership is what marks a real owner).
  - A TA merely granted `course-admin` on someone else's course does **not** qualify (still
    institution-adjacent, not an owner).
  - Reuses the exact "re-evaluate, upgrade-not-downgrade, owner-protected" pattern already built
    for LTI enrolment.

**Why this beats inferring from `User.source`:** `source` records the *mechanism*
(`firebase`/`google`/`lti`/`upload`), and crucially **course invitation creates no distinct
source** — an invited student accepts by signing up via Firebase/Google and lands tagged
`firebase`, indistinguishable from an organic hobbyist. Tagging intent at the gate captures the
decision the code already makes, dissolves the invitation ambiguity, and **protects organic users
for free** (default `permanent`). Steve's original "keep Sign-up users' work, expunge roster work"
goal becomes the *default behavior* of one field rather than a special case.

### 2. Retention is inactivity-based, per-course window over a system default

- **Trigger:** inactivity (time since last activity), **not** term-end (LTI doesn't reliably
  signal term boundaries).
- **Config:** `config.lti.retentionMonths` system-wide default; per-course `retentionMonths`
  override an instructor sets in course settings. **`0`/null = "never expire"** (what a self-host
  or keep-everything institution sets).
- **Activity tracking:** stamp `lastLaunchAt` on the **course membership** (inactivity is
  per-course, not per-user). This is a write on the launch hot path, so per the Firestore cost
  rule it is **throttled** — only re-stamp if the existing value is >24h stale.
- **Scope guard:** the sweeper only ever touches `expungable` accounts past their course's window.
  Account-level anonymize/delete only fires when an account's **last** active membership expires
  (the deletion spec's orphan check) — a student still active at another institution keeps the
  account and just drops the stale course.

### 3. Self-host as a documented fallback (kept in pocket, not a near-term build)

If an institution's InfoSec rejects third-party data processing, offer them a single-tenant
self-hosted instance so their data never lands in the central DB. The architecture **already
supports** this (backend-portability seam Firestore↔mongo/redis, deploy profiles, configurable
`instructorAuthority` gate). Near-term cost is only: (a) verify a clean single-tenant deploy works
end-to-end, and (b) a short "run-it-yourself" ops doc. Not a productization effort right now.
This is *additive* (central hosted instance stays the low-friction default for faculty-driven
adoption); it is not a replacement — see open decision #3.

## Grounding (verified against the code, 2026-06-22)

- **Provenance:** `User.source` (`lib/models/user.js:17`, default `'firebase'`). Distinct values
  written: `'firebase'` (`auth.js:89`), `'lti'` (`ltiProvision.js:57`), `'upload'`
  (`admin.js:161`, CSV bulk), `'google'` (legacy OAuth). Course invitation is stored in
  `CourseInvitation` and auto-accepted on signup → no distinct `source`.
- **Student content & feedback scoping** (better than feared): `Trinket`
  (`lib/models/trinket.js`) carries **both** `_owner` (User) **and** `courseId` (Course), plus
  `materialId` (assignment). Faculty feedback lives as `comments[]` nested *inside* the trinket
  (`trinket.js:51-64`), `commentType` ∈ `feedback` / `feedback-draft` / `student`. So student work
  and feedback **are cleanly course-partitionable by `courseId`** — per-course retention can target
  a student's submissions in one course precisely (unlike the shared-`User` account, which stays
  global). **Caveat:** each feedback comment **denormalizes `email` / `displayName` / `username`**,
  so feedback is itself a PII location to scrub — and is also exactly the faculty work-product the
  archive idea wants to preserve.

### 4. Archive-before-expiry (idea, shape agreed; mechanism parked)

Resolves the cost objection: let faculty **archive** the student work they want to keep *before*
expiry, then expiry **hard-deletes from the live DB** — PII gone *and* storage reclaimed, with
nothing of value lost. Archive ≈ a **course-scoped export of student submissions + feedback**,
which is almost exactly the **existing course export/import machinery** (the draft+globalSettings
round-trip already built — see `project_export_import_status`). The "extract documents from
archive" tool ≈ the reader side of that bundle. (Mechanism/custody = open decision #2.)

## Open decisions — parked for the meeting (week of 2026-06-22)

1. **Retention action:** anonymize-in-place vs. hard-delete vs. archive-then-hard-delete. (Steve
   wants conversations first. Note: anonymize alone does *not* solve the cost/growth driver;
   archive-then-hard-delete does.)
2. **Archive custody:** faculty-downloaded bundle (custody **and** cost leave trinket — feeds the
   "get out of custody" instinct, but faculty must store it and might not bother) vs. trinket-held
   cold storage (convenient, but trinket stays custodian and keeps paying).
3. **Self-host posture:** purely a fallback offer, or a strategic track worth productizing? And, if
   strategic — does it ever *replace* the central hosted model or only *augment* it?
4. **Retention defaults & rollout:** what is the default `retentionMonths` value, and does retention
   ship **on-by-default** (cures the headache automatically but auto-deletes by default — scary) or
   **opt-in per institution/course**?
5. **Edge case to confirm:** an account that entered `expungable` (invited/roster) but later does
   genuine *personal* work without becoming an owner stays expungable. Acceptable for v1? (The
   promotion rule covers anyone who becomes a real owner; this is the narrow "active personal user
   who never owns a course" gap.)

## Recommended sequencing (when un-paused)

1. **First (safe, fully decided, non-destructive):** the `retentionClass` field + gate/provision
   tagging + the promotion hook. Nothing is deleted; it only stamps a label every later policy
   keys off. Could proceed even before the destructive decisions are made.
2. **After the meeting (destructive policy):** the inactivity sweeper + archive, once the action
   (decision #1), archive custody (#2), and defaults/rollout (#4) are settled.

## Safety notes (carried from the deletion spec)

- Every destructive operation writes a `DeletionLog` audit entry (who/when/scope/counts, **no
  PII**) — the compliance evidence.
- Conservative defaults, dry-run, and `expungable`-only + past-threshold gating throughout.
- All portable to oss mongo/redis (plain model-layer fields and queries; no Datastore coupling).
