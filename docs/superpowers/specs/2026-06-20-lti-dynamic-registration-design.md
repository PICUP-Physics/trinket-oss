# LTI Dynamic Registration (self-service onboarding) — design

- **Date:** 2026-06-20
- **Status:** Approved (design); not yet implemented
- **Branch:** `lti-1.3`
- **Sub-project:** SP2 of the production instructor-flow roadmap (SP1 = deploy/ops pre-flight,
  SP2 = this, SP3 = Deep Linking). Each ships independently.
- **Related:** `LTI-SPEC.md`, `lib/controllers/lti.js`, `lib/models/ltiPlatform.js`,
  `lib/util/ltiKeys.js`, `lib/util/ltiState.js`, `lib/util/ltiVerify.js`,
  `lib/util/instructorAuth.js`, `lib/util/ltiInstructorAuthority*.js`, `config/routes.js`,
  `scripts/seed-lti-platform.js`

## Problem

Today, registering an LMS with trinket is fully manual: an LMS admin creates a developer
key/external tool, then a **trinket operator** hand-runs `scripts/seed-lti-platform.js` with the
issuer, client_id, deployment_id, and auth/jwks URLs copied from the LMS. This does not scale —
trinket already has 61 approved instructors across 50+ institutions, heading to hundreds — and the
manual client_id transcription is error-prone (cf. the Moodle capital-`I`/lowercase-`l` bug). There
is no self-service path, and the trinket operator is a per-institution bottleneck.

## Goal

Let an **approved instructor** start onboarding their institution's LMS and hand off to their LMS
admin to finish it, with **no trinket-operator data entry** — using the IMS **LTI Dynamic
Registration** protocol — while keeping the feature portable to the upstream mongo/redis
(trinket-oss) backend and not opening a platform-forgery / account-takeover hole.

## Decisions (locked)

1. **Self-service, instructor-initiated.** An approved instructor generates a token-gated
   registration link from an in-app page; the LMS admin completes Dynamic Registration. The trinket
   operator is removed from the happy path.
2. **Token gate.** `/lti/register` is gated by a trinket-issued, single-use, expiring registration
   token (sha256-hashed at rest). Not open; not pending-approval-on-open.
3. **One-click admin activation.** A dynamically-registered platform is created `pending` and is
   **not honored for launches** until a trinket admin activates it. This closes the forged-platform
   → email-takeover risk that instructor-level initiation would otherwise introduce (see Threat
   model). Manual `seed-lti-platform.js` creates `active` directly (the operator is already trusted).
4. **Approval-context display.** The activation view shows, per pending registration, the LMS
   identity (issuer, product family, deployment) **and** the initiating instructor's captured
   approval record from the `instructormi` Datastore: name + institution, approval date + approver,
   official + signin emails, role/title/notes.
5. **Auto-deployment on first launch.** Because Dynamic Registration frequently does not return a
   `deployment_id` (the LMS assigns it when the admin deploys), a launch whose `deployment_id` is
   unknown is accepted — and the deployment recorded — provided the platform is known **and** the
   id_token already verified against that platform's JWKS. The platform's signing key is the trust
   anchor; `deployment_id` only sub-identifies within one registration.
6. **v1 advertises `LtiResourceLinkRequest` only.** The `LtiDeepLinkingRequest` message type and its
   placements are added to the advertised tool-config in SP3.
7. **No AGS in v1.** We register `token_endpoint_auth_method: private_key_jwt` + `jwks_uri` (so AGS
   is a later config change, not a re-registration) but request **no** AGS scopes.
8. **oss portability.** All Datastore-backed pieces (the approval-record lookup) live behind the
   existing `instructorAuth` / `ltiInstructorAuthority` instructormi seam. The oss `default` build
   never loads `@google-cloud/datastore`; its activation view falls back to email + timestamp.

## The flow (three actors)

```
Approved instructor                LMS admin                     Trinket admin
───────────────────                ─────────                     ─────────────
1. Visit "Connect your LMS"
   (approved-instructor gated)
2. Generate registration link  ──► 3. Paste link into Canvas/
   trinket.io/lti/register?          Moodle dynamic-registration
   reg_token=<token>                 field. LMS opens it with
                                     ?openid_configuration=<url>
                                     &registration_token=<plat>
                                  ◄─ 4. GET /lti/register: validate
                                        reg_token, fetch openid-config,
                                        render confirm page
                                     5. Admin clicks "Register" →
                                        POST /lti/register: build tool-
                                        config, POST to platform's
                                        registration_endpoint, receive
                                        client_id, persist LtiPlatform
                                        (status:pending), mark token used,
                                        return IMS close page
                                                                  6. Review pending list
                                                                     (issuer + approval record)
                                                                  7. Click Approve → status:active
                                                                  8. Launches now honored
```

The two registration query params never collide: trinket's own gate is `reg_token`; the IMS-spec
param the LMS appends is `registration_token` (presented as a bearer to the platform, not consumed
by trinket's gate).

## Components

### 1. `lib/util/ltiRegistration.js` (new — the testable seam)

Pure-ish logic, no Hapi/HTTP-framework coupling, mirroring the `ltiVerify`/`ltiTarget` seams.

- `buildToolConfiguration()` → the OpenID Client Registration + LTI tool-config object trinket POSTs
  to the platform. Maps to existing endpoints via `config.url`:
  - `application_type: "web"`, `response_types: ["id_token"]`,
    `grant_types: ["client_credentials", "implicit"]`
  - `initiate_login_uri: <config.url>/lti/login`
  - `redirect_uris: [<config.url>/lti/launch]`
  - `jwks_uri: <config.url>/lti/jwks`
  - `client_name: "Trinket"`, `logo_uri: <config.url>/<logo>`
  - `token_endpoint_auth_method: "private_key_jwt"`, `scope: ""`
  - `"https://purl.imsglobal.org/spec/lti-tool-configuration": { domain, target_link_uri:
    <config.url>/lti/launch, claims: ["iss","sub","name","given_name","family_name","email"],
    messages: [{ type: "LtiResourceLinkRequest" }] }`
- `fetchPlatformConfig(openidConfigurationUrl)` → GET the platform's OpenID configuration (global
  `fetch`, Node 20). Returns the parsed config. **SSRF-guarded** (see Security).
- `register(openidConfig, registrationToken)` → POST `buildToolConfiguration()` to
  `openidConfig.registration_endpoint` with `Authorization: Bearer <registrationToken>` (when
  present). Returns the platform's registration response.
- `toPlatformFields(openidConfig, registrationResponse)` → maps to `LtiPlatform` fields:
  `issuer ← openidConfig.issuer`, `authLoginUrl ← authorization_endpoint`,
  `authTokenUrl ← token_endpoint`, `jwksUrl ← jwks_uri`,
  `clientId ← registrationResponse.client_id`,
  `deploymentIds ← [ tool-config.deployment_id ]` when the platform returns one (else `[]`),
  `productFamily ← lti-platform-configuration.product_family_code`, `name ← productFamily/issuer`.

### 2. `lib/models/ltiRegistrationToken.js` (new)

```
schema = {
  tokenHash       : { type: String, required: true },  // sha256(raw token), hex
  label           : { type: String },                  // e.g. "UIndy Canvas"
  initiatedByEmail: { type: String },                  // approved instructor who generated it
  expiresAt       : { type: Date,   required: true },
  usedAt          : { type: Date,   default: null },
  platformId      : { type: String, default: null }    // set when consumed
}
```
- `findByHash(tokenHash, cb)`.
- A token is valid iff it exists, `usedAt === null`, and `expiresAt > now`. Consumed (set `usedAt`,
  `platformId`) only on a **successful** registration POST.

### 3. `lib/models/ltiPlatform.js` (modified)

- Add `status` (`'pending' | 'active'`, default `'pending'`), `registeredVia`
  (`'dynamic' | 'manual'`), `productFamily` (String), `initiatedByEmail` (String).
- Add `addDeployment(deploymentId, cb)` — append to `deploymentIds` and save if absent (idempotent).
- `findByIssuer` unchanged (still keys on issuer + clientId).

### 4. `lib/controllers/lti.js` (modified)

- `registerInit` (`GET /lti/register`): validate `reg_token`; `fetchPlatformConfig`; render the
  confirm view with hidden fields carrying `openid_configuration`, `registration_token`, `reg_token`.
  On any failure render a clear error page (no record created).
- `registerComplete` (`POST /lti/register`): re-validate `reg_token`; `register(...)`;
  `toPlatformFields(...)`; create `LtiPlatform` `{ status:'pending', registeredVia:'dynamic',
  initiatedByEmail: <from token> }`; consume the token; return the IMS close page
  (`(window.opener||window.parent).postMessage({subject:'org.imsglobal.lti.close'}, '*')`).
- `loginInit` / `launch`: after `findByIssuer`, reject when `platform.status !== 'active'` with a
  clear "registration pending approval" message.
- `launch` deployment step (current step 4): replace the hard reject with — if
  `!platform.knowsDeployment(dep)` then `platform.addDeployment(dep)` and proceed (the id_token is
  already verified against the platform JWKS at this point). Still require a non-empty `deployment_id`
  claim.

### 5. Instructor "Connect your LMS" page (new controller action + view)

- Route gated by the **same approved-instructor check as course creation** (`canCreateCourse` /
  `instructorAuth`). Shows a *Generate registration link* button; on submit, mint a
  `LtiRegistrationToken` (random 32 bytes; store sha256; `expiresAt = now + 7d`;
  `initiatedByEmail = session user`) and display `<config.url>/lti/register?reg_token=<raw>` with
  copy button + step-by-step "send this to your LMS admin" instructions.

### 6. Admin activation page (new controller action + view)

- Route gated by trinket **admin** (`instructorAuth.isAdminEmail` / existing admin gate).
- Lists `LtiPlatform` where `status === 'pending'`. Each row: issuer, product family, deployment
  id(s), created date, **and** the initiating instructor's approval record (component 7). Buttons:
  **Approve** (`status → 'active'`) and **Reject/Delete** (remove the pending record — used for
  duplicates when two instructors at one school both initiate).
- CLI fallback `scripts/activate-lti-platform.js --issuer <iss> --client-id <cid>` for ops.

### 7. `instructorAuth.getInstructorRecord(email)` (new, instructormi seam)

- instructormi impl: query the `Instructor` kind by `emailOfficial` then `emailSignin` (as
  `isApprovedInstructor` does — no ancestor in the query, matching existing code) but **return the
  full entity** (not a boolean), cached like the existing check. Returns `null` if not found / not
  enabled.
- The `Instructor` schema (confirmed from `instructormi/app/main.py:77`, kind `Instructor` under
  ancestor `Key("Faculty","faculty")`) and how the activation view maps it:
  - `name` → instructor name
  - `emailOfficial`, `emailSignin` → institutional + signin emails (institution is inferred from the
    `emailOfficial` domain — **there is no explicit institution field**)
  - `date` → approval/record date; `processedby` → approving admin
  - `verification` → how they proved faculty status; `course` → course info; `comments` → approver notes
  - `authorized` (bool), `rejected` (bool) → **render these prominently** (see the gate caveat below)
  - The view renders present fields and tolerates missing ones.
- oss `default`: no such function / returns `null`; the activation view degrades to email + timestamp.

> **Gate caveat (caught while reading the schema — affects this feature):**
> `instructorAuth.isApprovedInstructor` returns `true` for **any** matching `Instructor` record — it
> does **not** filter on `authorized === true`, so *pending* and *rejected* requesters also pass the
> "approved-instructor" gate. That means the Connect-your-LMS page (component 5) would admit
> pending/rejected instructors too. The admin-activation step is therefore the real backstop: by
> rendering `authorized`/`rejected`/`date`/`processedby`, the admin can see whether the initiating
> instructor is genuinely authorized before activating. Whether to *also* tighten
> `isApprovedInstructor` to require `authorized === true` is a **separate decision** (it would change
> existing signup/launch behavior for everyone, not just LTI registration) — flagged here, not
> silently changed by this plan.

### 8. `scripts/generate-lti-registration-token.js` + `scripts/seed-lti-platform.js` (modified)

- New CLI to mint a token (ops fallback to the in-app page): `--label`, `--ttl-days`, prints the URL.
- `seed-lti-platform.js` sets `status:'active'`, `registeredVia:'manual'`.

### 9. `config/routes.js` (modified)

Add (string form, `auth:false` for the LMS-facing register endpoints; auth-gated for the two pages):
- `GET /lti/register lti.registerInit`
- `POST /lti/register lti.registerComplete`
- `GET  <connect-lms-page>` (approved-instructor gated)
- `POST <connect-lms-page>/token` (approved-instructor gated)
- `GET  <admin-activation-page>` (admin gated)
- `POST <admin-activation-page>/activate` (admin gated)

## Security / threat model

**Primary defense = the token gate + admin activation.** Initiation is limited to approved
instructors; *activation* is limited to trinket admins.

- **Forged-platform → email-takeover (the reason for activation):** `reg_token` only gates access;
  the `openid_configuration` is supplied by whoever opens the link. A rogue/compromised approved
  instructor could open their own link with an attacker-controlled `openid_configuration`,
  registering a platform whose `jwks_uri` is attacker-held, then mint a launch asserting
  `email: victim@…` to be linked into the victim's account. **Mitigation:** the platform lands
  `pending` and honors **no** launches until a trinket admin activates it after reviewing the issuer
  and the initiating instructor's approval record. `loginInit`/`launch` enforce `status === 'active'`.
- **SSRF (defense-in-depth on the outbound fetch/POST):** require https; ~5s timeout; response-size
  cap; **block private/loopback/link-local IP ranges** after DNS resolution. A `config.lti`
  dev/test flag (e.g. `allowPrivateRegistrationHosts`) re-permits private hosts so the
  `localhost` / `host.docker.internal` Canvas + Moodle testbeds remain reachable for live testing.
- **Token hygiene:** 32-byte random, sha256-at-rest, single-use, 7-day expiry, consumed only on
  successful registration.
- **Auto-deployment** is safe because it is gated on a JWT already verified against the (now
  admin-activated) platform's JWKS — see Decision 5.

## Data flow

1. Instructor page → mint `LtiRegistrationToken` (1 write).
2. LMS opens `GET /lti/register` → 1 token read + 1 outbound GET (openid-config) → confirm page.
3. `POST /lti/register` → 1 outbound POST (register) → 1 `LtiPlatform` write + 1 token update.
4. Admin activates → 1 `LtiPlatform` read (list) + 1 write (status). Approval record: 1–2 Datastore
   reads (cached 5 min).
5. First launch from the new platform → existing launch reads + possibly 1 `addDeployment` write.

Registration is rare (tens→hundreds of times total), so all writes are negligible per the CLAUDE.md
Firestore cost rules.

## Error handling

- Invalid/expired/used `reg_token` → error page, no record, token not consumed.
- openid-config fetch fails / non-https / private host (prod) / oversize / timeout → error page.
- Registration POST rejected by platform (bad `registration_token`, platform error) → error page,
  token **not** consumed (admin can retry with the same link).
- Launch against a `pending` platform → clear "registration pending approval" message (not a 500).
- Approval-record lookup failure / not-found → activation row still renders with LMS identity +
  email + timestamp (never blocks activation).

## Testing

- **Unit:** `buildToolConfiguration()` shape; `toPlatformFields()` mapping from sample
  openid-config + registration response; token generate/validate/expire/single-use; `addDeployment`
  idempotency; `status`-gating of `loginInit`/`launch`.
- **In-container mock-platform harness** (`scripts/test-lti-register.js`, gitignored per `test-*.js`):
  stub global `fetch` (or a tiny in-process http server) serving a fake openid-config +
  registration_endpoint that echoes a `client_id`; drive `GET` then `POST /lti/register`; assert the
  `LtiPlatform` is created `pending` with correct fields + provenance, token consumed, close page
  returned; assert reuse / expired / bad-token / pending-launch-rejected paths.
- **Regression:** existing launch/login/provision/authz suites stay green (status gate + relaxed
  deployment step must not break the seeded-active testbed platforms).
- **Live:** Dynamic Registration against the real Canvas + Moodle testbeds (with the dev
  private-host flag on), admin-activate, then a real launch end-to-end.

## Out of scope (later sub-projects)

- Deep Linking message type + course picker (SP3).
- AGS scopes / grade passback (v2).
- A polished admin dashboard (v1 ships a functional list + the CLI fallback).
- Self-service *re-registration* / key rotation flows.
