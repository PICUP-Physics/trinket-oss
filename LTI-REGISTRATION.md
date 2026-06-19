# Registering trinket as an LTI 1.3 Tool

How to connect a real LMS/test platform to trinket's LTI endpoints. Start with **Saltire**
(`https://saltire.lti.app/`) — a hosted LTI test *platform* that launches into your tool with no
install. Canvas notes are at the end. See LTI-SPEC.md for the design.

trinket exposes three endpoints (all on whatever host serves the app):

| Purpose | URL |
|---|---|
| OIDC login initiation | `<host>/lti/login` |
| Launch (redirect URI)  | `<host>/lti/launch` |
| Tool public keys (JWKS) | `<host>/lti/jwks` |

`<host>` must be reachable by the platform over **HTTPS** (Saltire is hosted, so it reaches you
over the public internet — localhost won't do).

---

## Step 1 — Get a reachable trinket with LTI active

Deploy the `lti-1.3` branch as a **no-traffic candidate** (real HTTPS, 0% prod traffic). From the
repo on `lti-1.3`, with `LTI_PRIVATE_KEY` set in `.env`:

```bash
NO_TRAFFIC=1 ./deploy-cloudrun.sh
```

Confirm the pre-flight banner shows **`LTI key: set`**, approve, and note the **tagged candidate
URL** it prints (e.g. `https://candidate---trinket-….run.app`). That's your `<host>`.

Sanity check: `curl <host>/lti/jwks` should return `{"keys":[{ "kid": … }]}`.

---

## Step 2 — Register trinket in Saltire (platform mode)

In Saltire, choose the flow where **Saltire acts as the platform launching a tool** (a "connect to
a tool" / "platform" configuration). Give it trinket's three URLs:

- **Tool login / OIDC initiation URL** → `<host>/lti/login`
- **Tool launch / redirect URL** → `<host>/lti/launch`
- **Tool JWKS / public keyset URL** → `<host>/lti/jwks`

Saltire will then show you the **platform** side values you need to register back in trinket:

- **Platform issuer** (`iss`) — e.g. `https://saltire.lti.app/platform`
- **Client ID** it assigned to trinket
- **Deployment ID**
- **Platform OIDC authorization endpoint** (the auth-redirect URL)
- **Platform JWKS URL** (where trinket fetches Saltire's public keys to verify the launch)

Keep these five values for Step 3.

---

## Step 3 — Tell trinket about the platform

Seed an `LtiPlatform` record with Saltire's values. Run against the deployed candidate's project
(or locally against the emulator to dry-run). Example:

```bash
node scripts/seed-lti-platform.js \
  --issuer "https://saltire.lti.app/platform" \
  --client-id "<client_id from Saltire>" \
  --auth-login-url "<platform OIDC authorization endpoint>" \
  --jwks-url "<platform JWKS URL>" \
  --deployment-id "<deployment_id>" \
  --name "Saltire"
```

(For Cloud Run, run it in the deployed environment — e.g. a one-off job/exec with the same
`GOOGLE_CLOUD_PROJECT` — so the record lands in the live Firestore, not the emulator.)

---

## Step 4 — Point the launch at a trinket course, then launch

v1 resolves the launch target from a **custom parameter** = a trinket **course id**. In Saltire's
launch config, add a custom parameter:

```
trinket_course = <the id of a trinket course to land in>
```

(Get the course id from trinket — e.g. the course's API/admin, or the URL. v1 uses the id, not the
slug.) Then trigger the launch from Saltire.

**Success looks like:** Saltire → trinket signs you in (no password) as the launched user, enrolls
you in the course (`course-admin` if Saltire sent an Instructor role, else `course-student`), and
lands you on the course page. Re-launching the same user does not create a duplicate.

---

## Troubleshooting

- **`Unknown LTI issuer`** at `/lti/login` → the `LtiPlatform` record's `issuer` doesn't match the
  `iss` Saltire sends. They must match exactly (Step 3).
- **Launch rejected, signature/JWKS error** → trinket couldn't fetch/verify against the platform
  JWKS URL. Confirm the `jwks-url` in Step 3 and that it's reachable from trinket.
- **`Unknown deployment_id`** → the `deployment_id` in the launch isn't in the platform record's
  `deploymentIds`; re-run the seed with the right `--deployment-id`.
- **`Invalid or expired state`** → the launch took >5 min, or `<host>` changed between login and
  launch (the `redirect_uri` must be a stable `<host>/lti/launch`).
- **Lands on `/welcome` instead of a course** → no `trinket_course` custom param, or the id doesn't
  match a course (Step 4).
- **Popup/iframe sign-in issues** → if the platform renders trinket in an iframe, the session
  cookie must be `SameSite=None; Secure` (HTTPS) — already the case on the candidate URL.

---

## Canvas (later, for realism)

Same three URLs. In Canvas you create an **LTI 1.3 Developer Key** (Admin → Developer Keys → +LTI
Key) with the login/launch/JWKS URLs; Canvas issues a **client_id** and exposes its issuer
(`https://canvas.instructure.com` or the instance), OIDC auth endpoint, JWKS URL, and a
deployment_id (after you enable the key and add the app). Seed those exactly as in Step 3. Canvas
custom-parameter substitution uses `$Custom.…`/literal values — set `trinket_course` to the course
id. Each Canvas *instance* is its own `LtiPlatform` record.
