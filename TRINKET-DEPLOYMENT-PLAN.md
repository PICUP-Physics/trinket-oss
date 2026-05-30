# Trinket-OSS: GCR Deployment & Firestore Adapter Plan

**Original:** 2026-04-06
**Last revised:** 2026-05-29
**Codebase:** trinket-oss (Hapi.js + Firestore + Firebase Auth + GCS)

---

## Status (2026-05-26)

The migration is largely complete. The app is running on Cloud Run against
Firestore, with Firebase Auth handling sign-in and GCS handling object
storage. The branch in active deployment is `gcr-firebase`.

Remaining work is cleanup and a single load-bearing session refactor before
opening to real classroom traffic.

### Done

| Area | Status | Location |
|------|--------|----------|
| Database backend abstraction | ✅ Done | `lib/db/backend-factory.js`, `lib/db/firestore-backend.js`, `lib/db/mongoose-backend.js` |
| Model factory delegates to backend | ✅ Done | `lib/models/model.js:4,102` |
| All 15 models migrated | ✅ Done | `lib/models/` (User, Course, Lesson, Material, Trinket, File, Folder, Interaction, Draft, CourseInvitation, Export, FeaturedCourses, ClientMetric, ErrorEvent, Asset) |
| Default backend = Firestore | ✅ Done | `config/default.yaml:377` (`db.backend: firestore`) |
| Cookie-first sessions (with Firestore fallback) | ✅ Done | `app.js:120-128` sets `maxCookieSize: 3500`; `lib/util/catbox-firestore.js` only catches sessions that exceed the cookie limit |
| Firebase Auth integration | ✅ Done | `lib/views/login.html`, `lib/controllers/auth.js`, see also `MANDI_AUTH.md` |
| Firebase Auth emulator for local dev | ✅ Done | `firebase.json`, `emulator.sh`, `FIREBASE_AUTH_EMULATOR_*` env vars in `docker-compose.yml` |
| Object storage migrated to GCS | ✅ Done | `lib/util/storage.js` uses `@google-cloud/storage`; snapshots in `trinket-snapshots` bucket |
| Cloud Run deploy pipeline | ✅ Done | `deploy-cloudrun.sh` (Cloud Build + Artifact Registry + Cloud Run) |
| Staged deploy workflow | ✅ Done | `NO_TRAFFIC=1 ./deploy-cloudrun.sh`, documented in `DEPLOYING.md` |
| Course invitation + roster gating | ✅ Done | `instructorAuth.isApprovedToSignup`, auto-accept on first login |
| Course create / copy restricted to instructors | ✅ Done | commit 20bb565 |

### Open work

1. **Remove the legacy server-side Google OAuth path** (dormant; see also
   the dormant OAuth client cleanup, pending re-check after next deploy).
   - Routes: `config/routes.js:399,405` (`/auth/google`, `/auth/google/callback`)
   - Handlers: `lib/controllers/auth.js:137-316` (`google`, `googleCallback`)
   - Include: `lib/views/includes/login-buttons.html` and the include site in `signup.html`
   - Env-var wiring: `app.js:62-67` (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`)
   - Secrets: `trinket-google-client-id`, `trinket-google-client-secret` (in Secret Manager); deploy-script bindings in `deploy-cloudrun.sh`

2. **Drop `aws-sdk` dependency.** Object storage is on GCS but
   `aws-sdk: ^2.1.20` is still in `package.json:23`. Confirm nothing imports
   it, then remove.

3. **Remove server-side execution config.** GlowScript is client-side only,
   so the `serverside:` block (`config/default.yaml:342`) and the
   `features.trinkets.python3/java/pygame/R` flags can go. Languages are
   already disabled by default, so this is purely cleanup.

4. **Container / port hygiene for concurrent dev.** Compose now uses
   `container_name: trinket-gcr` and host port `3001`, so this repo can run
   alongside the main `trinket-oss` clone. (Done in this revision.)

5. **Enable GCS file upload (materials bucket).** `features.assets` is
   currently `false` everywhere — file uploads are disabled. The
   `trinket-snapshots` bucket exists but no materials bucket does yet.
   Steps:
   - Create bucket: `gsutil mb -l US-CENTRAL1 -p trinket-gcr-test gs://trinket-materials`
   - Make publicly readable: `gsutil iam ch allUsers:objectViewer gs://trinket-materials`
   - Create HMAC keys for the Cloud Run service account:
     `gcloud storage hmac create <sa>@trinket-gcr-test.iam.gserviceaccount.com`
   - Store in Secret Manager (`trinket-aws-key-id`, `trinket-aws-key`) and
     wire into `deploy-cloudrun.sh` following the `SESSION_PASSWORD` pattern
   - Add GCS endpoint override to `config/aws.js`:
     `endpoint: 'https://storage.googleapis.com'`
   - Add to `production-cloudrun.yaml`: `features.assets: true`,
     `aws.keyId/key/region`, `aws.buckets.materials.name/host`
   - After enabling, run `node scripts/fix-imported-file-urls.js` to
     re-host existing imported course assets from trinket.io onto GCS

   Note: `aws-sdk` (item 2 above) cannot be dropped until this is resolved
   — the file upload path still uses it via `lib/util/file.js`.

6. **Production readiness pre-launch checklist** (not yet written):
   - Real Firebase Auth authorized-domains list (no `*.run.app` tagged URLs)
   - Cloud Run min-instances tuning
   - Firestore composite indexes for the queries that need them (verify via
     emulator query traces or first prod 500s)
   - Backup/export strategy for Firestore
   - Reconcile `config/default.yaml:56` (`maxCookieSize: 0`) with the
     `app.js:123` override (`3500`) — currently the config value is dead;
     either remove the dead config line or move the override into config.

---

## Context

This deployment serves **GlowScript** (VPython in the browser). All code
execution happens client-side via either the RapydScript runner
(`glowThings/rsWVPRunner/`) or the WASM/Pyodide runner
(`glowThings/wmWVPRunner/`). Server-side execution (Python/Java/R/Pygame
Docker containers) is not deployed.

**Usage pattern:** Students for a semester, then dormant — possibly forever.
Bursty during a term. Data long-lived but cold most of the time. Many
users, low sustained throughput.

**Why Firestore over Atlas:**

| | Atlas MongoDB | Firestore (Native) |
|---|---|---|
| Pricing | Storage volume (pay even when idle) | Per read/write (idle data nearly free) |
| Dedicated min | ~$57/mo (M10) | $0.06/100K reads, $0.18/100K writes, $0.18/GB/mo |
| Idle cost for 10 GB dormant data | ~$57+/mo | ~$1.80/mo |
| GCP integration | Third-party | Native (IAM, VPC, monitoring) |

Atlas penalizes the "lots of students who use it once" pattern. Firestore's
per-operation pricing is ideal for bursty educational use.

---

## Architecture

```
Controllers (unchanged from Mongoose era)
    │
    ▼
Model public API (findById, findByOwner, searchForOwner, …)
    │
    ▼
lib/models/model.js  (delegates via backend-factory)
    │
    ├──► lib/db/firestore-backend.js   ← active
    └──► lib/db/mongoose-backend.js    ← kept for local/legacy
    selected by config.db.backend
```

Plugins (timestamps, ownable, roles, slug, paginate, isChanged, orderedList)
have Firestore-equivalent implementations in the adapter layer.

**Session model:** cookie-first via yar (`app.js:120-128`,
`maxCookieSize: 3500`). Sessions live in the signed cookie when they fit,
which is the normal case. Anything larger spills into the server-side
cache backed by `lib/util/catbox-firestore.js`. Net effect: most requests
do zero Firestore work for session lookup.

**Auth model:** Firebase Auth + FirebaseUI on the client; server verifies
ID tokens with the Firebase Admin SDK and issues a yar session. Local dev
uses the Firebase Auth emulator. Roster-gated signup: a user can only
create an account if their email is on a course roster or matches an
approved instructor list. See `MANDI_AUTH.md` for the full flow.

---

## Reference: MongoDB feature audit (historical)

Kept for context — these were the patterns the Firestore backend had to
support. Implementation is in `lib/db/firestore-backend.js`.

| Category | MongoDB feature | Count | Firestore Native | Note |
|----------|----------------|-------|-----------------|------|
| Basic CRUD | find, findOne, findById, save, delete | 50+ | ✅ | |
| Equality | `{ field: value }` | 50+ | ✅ | |
| Range | `$gt`, `$lt`, `$gte`, `$lte` | 5 | ✅ | |
| In-list | `$in` | 4 | ✅ (max 30) | |
| Not-equal | `$ne` | 5 | ✅ | |
| Exists | `$exists` | 3 | ✅ (`!= null`) | |
| Sort | `.sort()` | 10 | ✅ | composite index for multi-field |
| Count | `.count()` | 1 | ✅ | |
| OR | `$or` | 8 | ✅ | |
| Atomic increment | `$inc` | 3 | ✅ (`FieldValue.increment()`) | |
| Pagination | `.skip()`, `.limit()` | 8 | partial | cursors instead of offset |
| Regex search | `RegExp()` | 1 | client-side | owner-scoped, <1000 docs |
| Array subdoc query | `$elemMatch` | 7 | structural | denormalized to subcollections |
| Aggregation | `.aggregate()` | 5 | structural | reimplemented in JS |
| Array mutation | `$push`/`$pull`/`$addToSet` | 10+ | partial | `arrayUnion`/`arrayRemove` for flat values, transaction for objects |
| Positional update | `$set` with `$` | 5 | transaction | read-modify-write |
| Upsert | `findOneAndUpdate` + upsert | 2 | `set(merge: true)` in transaction | |
| Populate/join | `.populate()` | 2 | explicit multi-get | |
| Compound unique | `unique` compound index | 3 | transaction | application-level enforcement |
| Schema hooks | pre/post save/remove | 8 | adapter middleware | |

### Firestore subcollection mapping

```
courses/{courseId}
  ├── enrollments/{enrollmentId}     (replaces embedded users[])
  └── invitations/{invitationId}     (where applicable)

trinkets/{trinketId}
  ├── comments/{commentId}           (replaces embedded comments[])
  └── assets as flat array

folders/{folderId}
  └── memberships/{membershipId}     (replaces embedded trinkets[])
```

---

## Risk notes for the remaining work

- **Session size discipline.** Sessions currently fit in the 3500-byte
  cookie. If new code starts stashing larger objects in `request.yar.set`,
  sessions will spill into Firestore and every request for that user will
  start paying a round-trip. Watch yar usage when adding flash/session
  data.
- **The MongoDB backend is still present** (`lib/db/mongoose-backend.js`).
  Don't rip it out yet — it's the fallback if the Firestore path develops
  an unrecoverable issue. Remove it only after a term of stable Firestore
  production traffic.
- **No Firestore composite indexes are pre-declared.** The first time a
  multi-field sorted query runs in prod, Firestore will throw and the
  error will include a one-click index-creation URL. Watch for these
  during the first deploy and during initial real-user traffic.

---

## Load testing: ideas to discuss with the team

Not yet decided — captured here so we can come back to it.

### The hard part is auth, not HTTP

Every simulated user needs a valid Firebase ID token, then exchanges it
for a yar session cookie via `POST /api/auth/session`. Once you have the
cookie, the rest is plain HTTP. Two paths to get tokens at scale:

1. **Staging Firebase project with N test users.** Pre-create test
   accounts in a separate Firebase project, sign each in once via the
   Identity Toolkit REST API (`accounts:signInWithPassword`) at the start
   of the run, cache the cookie, then drive load with that cookie pool.
   Closer to real user flow. Recommended.
2. **Custom-token mint via Admin SDK.** Mint custom tokens server-side,
   exchange for ID tokens. Faster setup but skips the popup/redirect path
   real users take, so it doesn't exercise FirebaseUI.

### Recommended tool

**k6.** JavaScript scripting, ramped-VU stages, thresholds, OSS. Can
script the one-time auth handshake then drop to plain HTTP for the bulk
of the run. Locust (Python) is also viable if more complex per-user state
is needed.

### Where to point it

- Deploy a no-traffic tagged revision (`NO_TRAFFIC=1 ./deploy-cloudrun.sh`).
- Use a **separate Firestore project** for test data. Loading real prod
  Firestore costs real money and contaminates user data.
- Realistic ramp: 200 VUs over 5 min, hold 10 min, ramp down. Mimics a
  class period landing on the site — not a flat constant.

### Hot paths to exercise

Cost driver is Firestore ops, not Cloud Run CPU. Bias the test mix toward
endpoints that fan out the most reads:

- Course dashboard (`/courses/:slug` with lesson/material hierarchy)
- Trinket listing for an owner
- Embed view (called out as a hot path in `CLAUDE.md`)

### Counter-suggestion to weigh

For ~few hundred students total, **one real beta class** with Cloud Run
metrics + Firestore usage dashboard open is likely to surface more useful
information faster than synthetic load — and at lower setup cost.
Synthetic load shines when you need to answer "can we handle 10× current
load?" For "does this hold up under real classroom use?" real traffic
beats simulated.

### Decisions to make with the team

- Synthetic load test, beta cohort, or both?
- If synthetic: how many simulated concurrent students? What's the
  realistic peak (one class period × N students)?
- If beta: which class(es), which term, what's the rollback plan if
  something breaks mid-session?
- Budget for Firestore ops during testing — what's acceptable?


❯ OK, I need to investigate costs for various deployment options. Imagine we have 100s of instructors, and (probably) thousands of students. Compare: 1) using the gcr/firebase       
  deployment we've been testing vs. 2) A well configured VPS (maybe 32G RAM, 500G HD space) running MongoDB/Redis. How would the costs compare? How would the user experience         
  compare? What happens if we get 10x users? Can you write up some pros/cons for these two situations?                                                                                
  
⏺ Here's a grounded comparison based on what this stack actually does:
  
  ---
  GCR + Firestore vs. VPS (MongoDB/Redis)
  
  Baseline assumptions

  - Hundreds of instructors = ~500 MAU instructors
  - Thousands of students = ~3,000 MAU students
  - Average student: 15 page loads/day on active days, ~10 active days/month
  - Average instructor: 20 page loads/day on active days, ~20 active days/month
  - Firestore reads per page load: ~10 (course, lesson, material, user, enrollment checks)
  - Writes: ~5/student submission

  ---
  Cost estimates — current load

  GCR + Firestore

  ┌────────────────────────────────────┬───────────────┐
  │                Item                │    $/month    │
  ├────────────────────────────────────┼───────────────┤
  │ Firestore reads: ~4.5M/month       │ $2.70         │
  ├────────────────────────────────────┼───────────────┤
  │ Firestore writes: ~450k/month      │ $0.81         │
  ├────────────────────────────────────┼───────────────┤
  │ Firestore storage (grows slowly)   │ $1–5          │
  ├────────────────────────────────────┼───────────────┤
  │ Cloud Run CPU+memory               │ $5–15         │
  ├────────────────────────────────────┼───────────────┤
  │ Firebase Auth (free tier: 10k MAU) │ $0            │
  ├────────────────────────────────────┼───────────────┤
  │ Total                              │ ~$10–25/month │
  └────────────────────────────────────┴───────────────┘

  VPS (Hetzner CX52: 16 vCPU, 32GB RAM, 500GB NVMe)

  ┌────────────────────────────────────────────────────────┬───────────────┐
  │                          Item                          │    $/month    │
  ├────────────────────────────────────────────────────────┼───────────────┤
  │ Server (Hetzner CPX51)                                 │ ~$55          │
  ├────────────────────────────────────────────────────────┼───────────────┤
  │ Backups                                                │ ~$10          │
  ├────────────────────────────────────────────────────────┼───────────────┤
  │ Monitoring (e.g. UptimeRobot free / Better Uptime $20) │ $0–20         │
  ├────────────────────────────────────────────────────────┼───────────────┤
  │ Total                                                  │ ~$65–85/month │
  └────────────────────────────────────────────────────────┴───────────────┘

  At baseline, GCR + Firestore is cheaper — but only if the Firestore access patterns are disciplined (the CLAUDE.md warning is real: one bad N+1 loop in a hot path can 10× read
  costs overnight).

  ---
  Cost estimates — 10× users (~30,000 students)
  
  GCR + Firestore

  Firestore reads scale linearly. At 10×:
  - Reads: ~45M/month → $27/month
  - Writes: ~4.5M/month → $8/month
  - Cloud Run scales automatically → ~$50–100/month at peak
  - Total: ~$85–135/month
  
  ...assuming no N+1 regressions. A single dashboard page that reads each student's submission individually (N+1) at 30 students/assignment → 30× the expected read cost for that
  page. One careless query in a hot path could easily push you to $300–500/month.

  VPS — same hardware
  
  A 32GB/16-core machine running Node.js (PM2 cluster), MongoDB with adequate RAM for working set, and Redis for sessions will handle 30,000 students comfortably. The codebase is
  Hapi — stateless request handlers, fast. You'd want to check MongoDB indexes but otherwise:
  - Total: ~$65–85/month (same server, maybe add $20 for bigger backup storage)
  
  At 10×, the VPS wins on cost and becomes more predictable.

  ---
  User experience

  ┌────────────────┬──────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────┐
  │   Dimension    │                               GCR + Firestore                                │                                      VPS                                      │
  ├────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────┤
  │ Cold starts    │ 2–5 sec latency after idle period (configurable min-instances=1 fixes this,  │ None — process always running                                                 │
  │                │ ~$20/month)                                                                  │                                                                               │
  ├────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────┤
  │ Latency at     │ Scales out automatically; no degradation under traffic spikes                │ Fixed capacity; needs PM2 workers tuned; could degrade under surprise traffic │
  │ load           │                                                                              │  spike                                                                        │
  ├────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────┤
  │ Availability   │ Google's 99.95% SLA                                                          │ Whatever you configure; single machine = single point of failure unless you   │
  │                │                                                                              │ add a replica                                                                 │
  ├────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────┤
  │ Ops burden     │ Near-zero: no patching, no backups, no disk management                       │ Real: OS patches, MongoDB backups, disk monitoring, log rotation              │
  └────────────────┴──────────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────┘

  ---
  What happens at 10× users?

  GCR + Firestore:
  - Scales transparently — no intervention needed
  - Costs climb predictably if code is clean; unpredictably if there are read hotspots
  - Firestore has no "slow query" visibility — you need to instrument reads manually to catch regressions
  
  VPS:
  - 32GB / 500GB handles it easily (MongoDB working set for thousands of courses/submissions fits in RAM)
  - If you eventually hit 100k+ students you'd upgrade the machine or add a read replica — straightforward
  - MongoDB slow query log gives you instant visibility into problems 

  ---
  Recommendation

  ┌────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────┐
  │                                Scenario                                │                           Recommendation                           │
  ├────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ Small team, no dedicated sysadmin, want to stay focused on product     │ GCR + Firestore — the ops savings pay for the cost premium         │
  ├────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ You have someone comfortable with Linux/MongoDB, cost matters at scale │ VPS — cheaper at 10×, more predictable, better query observability │
  ├────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ Regulatory / data residency requirements                               │ VPS — you control where data lives                                 │
  ├────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ You expect sudden viral traffic spikes                                 │ GCR — auto-scaling is genuinely valuable here                      │
  └────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────┘

  The codebase already has the MongoDB backend wired up (db.backend: mongoose in config), so switching from Firestore back to MongoDB on a VPS is a config change + migration script,
  not a rewrite. That's a meaningful hedge — you're not locked in to either choice permanently.


