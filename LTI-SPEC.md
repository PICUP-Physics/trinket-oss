# LTI 1.3 Integration — v1 Spec (Launch + SSO)

Status: **draft** · Target fork: trinket-gcr (Firestore backend) · Author: Steve Spicklemire (with Claude)
Date: 2026-06-19

trinket acts as an **LTI 1.3 Tool**: an LMS (Canvas, Moodle, Brightspace, Schoology, …)
launches a user into a trinket course, topic, or assignment. v1 is **launch + SSO only**.

---

## 1. Goals

- An instructor places trinket links in their LMS; students click and land in the right
  trinket course/topic/assignment, already signed in, with no separate trinket account step.
- A launched user is mapped to a trinket user (created if needed) and auto-enrolled in the
  linked course, **bypassing the email/roster gate** in `auth.js`.
- One trinket tool registration supports **multiple placement types**: content-area / nav
  links → course or topic; assignment-tool links → assignment trinket.

## 2. Non-goals (explicitly deferred)

- **Deep Linking** (instructor picks the target from inside the LMS). v1 uses custom
  parameters + a resource-link mapping instead.
- **Assignment & Grade Services (AGS)** / grade passback. Blocked by the state-not-score
  model (see §9). Assignment launches work; the LMS gradebook column stays manual until AGS.
- **Names & Role Provisioning Service (NRPS)** / roster sync.
- **LTI 1.1** legacy support.
- **Dynamic registration** (LTI Advantage auto-registration). v1 registers platforms manually.
- **mongo/redis storage implementation.** v1 implements only the Firestore backend, but routes
  storage through a thin seam (§10.1) so a mongo/redis impl can be added later without
  refactoring — so oss/upstream users can adopt this work. Anticipated, not built now.

## 3. Terminology

- **Platform** = the LMS (the OIDC provider that issues the launch JWT).
- **Tool** = trinket (this app).
- **Deployment** = a platform's specific install of the tool (`deployment_id`).
- **Resource link** = one placement of the tool in the LMS (`resource_link_id`); each maps
  to a trinket target.

## 4. User stories & acceptance criteria

1. **Student launch.** Given an instructor placed a trinket course link and a student clicks
   it in the LMS, the student is signed into trinket (no password), enrolled in the linked
   course, and lands on the course page. AC: a trinket user exists keyed to `(iss, sub)`; a
   yar session cookie is set; the student is a member of the course; redirect lands on the
   target.
2. **Instructor launch.** Same, but launched user with an instructor role lands with edit
   rights on the course. AC: launch roles map to a trinket course role (see §8.4).
3. **Assignment launch.** A link in the LMS assignments tool launches the student into a
   specific assignment trinket. AC: target resolves to the assignment; submission tracking
   works as it does today. (No grade is sent back in v1.)
4. **Repeat launch.** A returning user re-launching is matched to the *same* trinket user and
   not duplicated. AC: lookup by `(iss, sub)` returns the existing user.
5. **Untrusted/invalid launch is rejected.** A launch with a bad signature, unknown issuer,
   expired/`exp` past, reused `nonce`, mismatched `state`, or unknown `deployment_id` is
   refused with a clear error and no session. AC: each failure path returns 401/400 and logs.

## 5. Endpoints (new)

All public (no existing `auth:'session'`); the launch itself establishes the session.
New controller `lib/controllers/lti.js`, routes in `config/routes.js`.

| Route | Purpose |
|---|---|
| `GET\|POST /lti/login` | OIDC third-party-initiated login. Receives `iss`, `login_hint`, `target_link_uri`, `lti_message_hint`, `client_id`, `lti_deployment_id`. Looks up the platform by `iss`(+`client_id`), generates a `nonce` and a **stateless signed `state`** (a short-lived HMAC/JWT carrying the nonce, `iss`, `client_id`, target, `iat`/`exp` — see §7.1; nothing stored server-side), and 302-redirects to the platform's auth endpoint with `scope=openid&response_type=id_token&response_mode=form_post&prompt=none&login_hint=…&state=…&nonce=…&redirect_uri=<our /lti/launch>`. |
| `POST /lti/launch` | Redirection URI. Receives `id_token` (JWT) + `state`. Validates everything (§7), provisions the user + session (§8), resolves the target (§6), 302-redirects into the app. |
| `GET /lti/jwks` | The Tool's public JWKS (for platforms that verify Tool-signed JWTs — needed later for Deep Linking/AGS; exposed now so registration is complete). |

**Registration handoff** (give the LMS admin): Login URL `…/lti/login`, Redirect/Launch URL
`…/lti/launch`, JWKS URL `…/lti/jwks`, plus the Tool's `client_id` per platform.
Base host comes from `config.url` (see PUBLIC_HOSTNAME work — must be the custom domain).

## 6. Target resolution (multiple placement types, no Deep Linking)

A launch carries `context` (LMS course) and `resource_link.id`. We resolve it to a trinket
target via, in priority order:

1. **Existing `LtiResourceLink` mapping** for `(platformId, resource_link_id)` → render that.
2. **Custom parameters** on the launch (`https://purl.imsglobal.org/spec/lti/claim/custom`):
   - `trinket_course=<slug>` → course landing page
   - `trinket_topic=<courseSlug>/<topicSlug>` → topic
   - `trinket_assignment=<materialId|shortCode>` → assignment trinket
   On first launch, **persist** the resolved mapping as an `LtiResourceLink` so subsequent
   launches skip the custom-param lookup (and Deep Linking later writes the same record).
3. **Fallback:** if nothing resolves, land on a "this link isn't configured yet" page that
   tells an instructor what custom parameter to set.

`context` maps to a trinket course via `LtiResourceLink.courseId` (and is the enrollment
target in §8). This generalizes the existing `course.externalLink {source, sourceId}` idea.

## 7. Launch validation (security)

### 7.1 Stateless `state` + nonce (no shared cache needed)

gcr runs no redis, and `Store`'s `get`/`set` are **in-memory per Cloud Run instance** — so
`/lti/login` and `/lti/launch` can hit different instances (or the instance can scale to zero
between them). Storing `state`/`nonce` in-memory would fail intermittently. Instead:

- **`state` is a self-contained signed token** (HMAC-SHA256 with a server secret, or a JWT
  signed by the Tool key) carrying: `nonce`, `iss`, `client_id`, `target_link_uri`, `iat`,
  `exp` (~5 min). It is **not stored** — it's verified on launch by recomputing/validating the
  signature and checking `exp`. This gives CSRF protection and binds the nonce to the request
  with zero storage.
- **Replay protection** is the only thing that needs shared state: record each consumed
  `nonce` (or the id_token `jti`) in the `LtiNonce` Firestore collection with a **native TTL**
  policy (auto-deletes after expiry; see §10). One write + one read per launch.

### 7.2 Validation order

On `POST /lti/launch`, in order, reject on any failure:

1. **`state` signature + `exp` valid** (it's the token we issued at `/lti/login`; CSRF). Extract
   the embedded `nonce`, `iss`, `client_id`.
2. Decode `id_token` header → `kid`; fetch platform JWKS (cached in-memory, see §10) → verify
   RS256 signature.
3. `iss` == registered platform issuer **and matches `state.iss`**; `aud` contains our
   `client_id` (if `aud` is an array with multiple, `azp` == our `client_id`).
4. `exp` in the future, `iat` recent (allow small clock skew, e.g. ±5 min).
5. id_token `nonce` == the `nonce` embedded in `state`, **and** not already present in
   `LtiNonce` (replay). Then record it in `LtiNonce`.
6. `https://purl.imsglobal.org/spec/lti/claim/deployment_id` is known for this platform.
7. `message_type` == `LtiResourceLinkRequest`; `version` == `1.3.0`.

Only after all pass do we read identity/context/roles/custom claims.

## 8. User provisioning, identity, session

### 8.1 Identity key
Primary key is **`(iss, sub)`** — the platform issuer + stable per-platform subject. Do **not**
key on email (LTI email may be absent or shared as private). Store email/name when provided.

### 8.2 Lookup / create
- Look up `LtiUserIdentity` by `(iss, sub)` → trinket `userId`.
- If found, load that user.
- If not, create a trinket `User` (username derived/uniquified; email if provided), then
  create the `LtiUserIdentity` link. This **bypasses** the `auth.js` roster-email gate
  entirely — LTI is its own trusted provisioning path.

### 8.3 Enrollment
Enroll the user in the launch's course (`LtiResourceLink.courseId`) if not already a member,
reusing the existing course-membership mechanism (`course.addUser` / the invitation
auto-accept path in `auth.js:94`). Idempotent on repeat launches.

### 8.4 Role mapping
LTI roles claim → trinket course role:
- `…membership#Instructor` / `…#ContentDeveloper` / `…#TeachingAssistant` → editor/teacher role
- `…membership#Learner` → student
- Unknown → student (least privilege).

### 8.5 Session handoff
Establish the session the same way `POST /api/auth/session` does: set `request.yar` userId and
reset/regenerate the session, then 302 to the resolved target. Reuses the existing cookie-first
yar session (see the cookie-session note in project memory). No Firebase token involved on this
path.

## 9. Grade/submission note

trinket represents student work as a trinket with `submissionState`
(`started`/`modified`/`submitted`/`completed`) — there is **no numeric score field**. v1 sends
nothing back to the LMS. When AGS is added later, the minimal mapping is completion → score
(e.g. `submitted`/`completed` → 1.0); a real rubric/points model is a separate project.

## 10. Data model (new Firestore-backed models)

Follow the existing `lib/models/*` pattern (works on the Firestore backend).

- **`LtiPlatform`** — one per LMS registration:
  `issuer`, `clientId`, `authLoginUrl` (platform OIDC auth endpoint), `authTokenUrl` (for
  later AGS), `jwksUrl`, `deploymentIds: [String]`, `name`. Indexed by `issuer`(+`clientId`).
- **`LtiResourceLink`** — `platformId`, `resourceLinkId`, `contextId`, `courseId`,
  `targetType` (`course|topic|assignment`), `targetId`. Indexed by
  `(platformId, resourceLinkId)`.
- **`LtiUserIdentity`** — `iss`, `sub`, `userId`, plus cached `email`/`name`. Indexed by
  `(iss, sub)`. (Alternative: embed an array on `User`; a separate model keeps `User` clean
  and the index tight.)
- **`LtiNonce`** — replay protection only: `nonce` (or id_token `jti`), `expiresAt`. A
  **Firestore TTL policy** on `expiresAt` auto-deletes expired docs (no manual cleanup). One
  write + one read per launch. `state`/`nonce` are otherwise stateless (§7.1), so this is the
  *only* per-launch write the LTI security path requires.

**No redis (gcr runs none).** `Store`'s `get`/`set` are in-memory **per Cloud Run instance**,
so they can't hold cross-request state/nonce — hence the stateless signed `state` (§7.1).
Shared state lives in Firestore. Cost is negligible at education volumes: steady-state ~3
reads + ~1 write per launch (table below), and launches are rare per user (not a hot path like
embed/course loads). Caches that *can* be per-instance — `LtiPlatform` records and platform
JWKS (refetch on unknown `kid`) — stay in process memory; they're public/rarely-changing and
re-fetchable, so the per-instance limitation is harmless there.

| Volume | Reads/day | Writes/day | Firestore cost |
|---|---|---|---|
| 3,000 launches/day (~1,000 students) | ~9K | ~3K | within free tier → **$0** |
| 30,000 launches/day (very large) | ~90K | ~30K | a few **cents**/day |

(Firestore free tier ≈ 50K reads / 20K writes per day; paid ≈ $0.06/100K reads, $0.18/100K
writes.) `LtiUserIdentity` and `LtiResourceLink` lookups are single indexed reads; writes occur
only on first-ever launch of a user / resource link.

### 10.1 Backend portability (facade seam — design now, build later)

v1 implements **only the Firestore backend**, but storage is routed through a thin seam so a
mongo/redis implementation can be added later (for oss/upstream users) **without refactoring the
LTI controller**. We do *not* build the mongo/redis side now (§2). The seam is deliberately small:

- **`state`/`nonce` binding** — already backend-agnostic (signed `state` stores nothing, §7.1).
  No seam needed; works on both branches as-is.
- **Nonce replay store** — the one piece with backend-specific TTL semantics. Hide it behind a
  one-method interface:

  ```
  ltiNonceStore.checkAndRecord(key, ttlSeconds) -> Promise<boolean>   // true if fresh, false if replay
  ```
  - Firestore impl (built now): `LtiNonce` collection + native TTL policy.
  - redis impl (later): `SET key 1 NX EX <ttl>` — atomic check-and-record, TTL built in (a
    cleaner fit than Firestore, in fact).
  Select the impl off `config.db.backend`, mirroring how `Store` already branches.
- **Persistent models** (`LtiPlatform`, `LtiResourceLink`, `LtiUserIdentity`) — ride the
  **existing model layer**, which already abstracts Firestore vs mongo. No new facade; a mongo
  deployment gets them for free once the model layer is wired (as it is for current models).

Net: the only backend-specific code to write later is one `ltiNonceStore` redis impl. The
controller, validation, provisioning, and models stay backend-neutral.

## 11. Config & secrets

- **Tool keypair** (RS256) for signing Tool JWTs (JWKS, and later Deep Linking/AGS). Private
  key in Secret Manager (mirror the `deploy-cloudrun.sh` secret pattern); public key served at
  `/lti/jwks`. Generate once; support `kid` + rotation.
- **Platform registrations**: stored as `LtiPlatform` records (seedable via a small admin
  script or, later, an admin UI). v1 can seed via a script like `scripts/`.
- `jsonwebtoken` is already a dependency; add a JWKS client (e.g. `jwks-rsa`) for fetching/
  caching platform keys.
- **`state` signing**: reuse the Tool keypair to sign `state` as a short JWT (no extra secret),
  or use a dedicated HMAC secret in Secret Manager. Either way, no shared cache is needed for
  `state` (§7.1).

## 12. Mapping to existing code

- New: `lib/controllers/lti.js`, `lib/models/ltiPlatform.js`, `lib/models/ltiResourceLink.js`,
  `lib/models/ltiUserIdentity.js`, `lib/models/ltiNonce.js` (TTL), `lib/util/ltiNonceStore.js`
  (the §10.1 seam; Firestore impl now, redis impl later), routes in `config/routes.js`, a seed
  script.
- Reuse: yar session handoff (cf. `auth.js` session creation), course enrollment
  (`course.addUser` / invitation auto-accept), `config.url` for absolute URLs (now custom-domain
  correct via `PUBLIC_HOSTNAME`), role/permission helpers.
- `state`/`nonce` use a stateless signed token + the `LtiNonce` TTL collection (§7.1) — **not**
  the in-memory `Store` (which doesn't survive across Cloud Run instances).
- The roster-email gate in `auth.js` is intentionally **not** on the LTI path.

## 13. Milestones (suggested build order)

1. Tool keypair + `GET /lti/jwks` + `LtiPlatform` model + seed script. (Registerable shell.)
2. `GET\|POST /lti/login` — OIDC init with a stateless signed `state` (§7.1).
3. `POST /lti/launch` — full JWT validation (§7) against a real platform JWKS, incl. replay
   protection via the `ltiNonceStore` seam (Firestore impl; §10.1).
4. Provisioning + session handoff (§8) → land on a fixed course (hard-coded target).
5. Target resolution (§6) — custom params + `LtiResourceLink`, all three target types.
6. Role mapping + enrollment idempotency + error pages.
7. Docs: how to register trinket in Canvas/Moodle (the three URLs + client_id).

## 14. Testing strategy

- Unit: JWT validation matrix (good, bad-sig, wrong-aud, expired, replayed-nonce,
  unknown-deployment, bad-state).
- Integration: a mock platform (issue our own signed id_token against a test JWKS) driving
  `/lti/login` → `/lti/launch` end-to-end, asserting user creation, enrollment, session, and
  target redirect. The in-container test technique (see project memory) fits here.
- Manual: register against a real Canvas test instance (or `saltire.lti.app` / the IMS
  reference test platform) and verify all three placement types.

## 15. Open questions

- Multi-tenant platform management: script-seeded for v1, but who administers `LtiPlatform`
  records long-term — an admin UI?
- Username/email collisions when provisioning (LMS user whose email already maps to an
  existing non-LTI trinket account — link or keep separate?).
- Whether the assignment placement should pre-create an AGS line item now (even unused) to
  ease the later AGS phase.
- Upstream: the facade seam (§10.1) makes this portable to trinket-oss — the only remaining
  work for upstream adoption is one `ltiNonceStore` redis impl. Whether/when to do that is a
  maintainer decision (cf. the instructor-gate divergence). v1 ships Firestore-only.
