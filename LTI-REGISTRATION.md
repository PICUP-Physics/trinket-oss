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

### Faster alternative to Step 1: tunnel a local instance (no deploy)

A Cloud Build deploy takes minutes; a tunnel gives seconds and writes only to your **local
emulator** (zero production data touched). Expose the local stack over public HTTPS, and tell the
local app its public host so the launch `redirect_uri` is the tunnel URL (not `localhost`):

```bash
# 1. tunnel the local app (host port 3001). Free, no account:
cloudflared tunnel --url http://localhost:3001      # -> prints https://<something>.trycloudflare.com
#    (or: ngrok http 3001)

# 2. point the local app at that host and reload (env change recreates the container):
export LTI_PUBLIC_HOST=<something>.trycloudflare.com LTI_PUBLIC_PROTO=https LTI_PUBLIC_PORT=null
docker compose up -d

# 3. sanity check through the tunnel:
curl https://<something>.trycloudflare.com/lti/jwks      # -> {"keys":[{ "kid": … }]}
```

Now `<host>` = `https://<something>.trycloudflare.com` for Steps 2–4. The `trinket_course` you
target in Step 4 must be a course in your **local emulator** (create one in the local UI).

Notes:
- The `LTI_PUBLIC_*` vars default to `localhost`/`http`/`3001`, so normal local dev is unchanged
  when they're unset (`unset LTI_PUBLIC_HOST LTI_PUBLIC_PROTO LTI_PUBLIC_PORT; docker compose up -d`).
- After **code** edits (not env), reload with `docker restart trinket-gcr` — `node app.js` doesn't
  hot-reload volume-mounted files.
- Free `cloudflared`/`ngrok` tunnels get a **new random URL each run**, so you re-enter the URLs in
  Saltire each session. For repeated use, a named cloudflared tunnel or a reserved ngrok domain
  gives a stable host.
- Launch **top-level** (not in an iframe) from Saltire to avoid third-party-cookie/SameSite issues.

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

## Canvas (LTI 1.3 Developer Key)

Same trinket URLs as Saltire; Canvas is just a different platform record. Two things to know up
front:

- **You need Canvas *admin* access** (to create Developer Keys). **Canvas Free-for-Teacher does
  NOT grant this** — use a local Canvas (Docker) or an instance where you're an account admin.
- Canvas must reach `<host>` over HTTPS — same tunnel or candidate-deploy rule as Saltire.

### A. Create the Developer Key (Canvas admin)

1. **Admin → Developer Keys → + Developer Key → + LTI Key.**
2. Configure (Method: **Manual Entry**):
   - **Title:** `trinket`
   - **Target Link URI:** `<host>/lti/launch`
   - **OpenID Connect Initiation Url:** `<host>/lti/login`
   - **JWK Method:** *Public JWK URL* → `<host>/lti/jwks`
   - **Redirect URIs:** `<host>/lti/launch`
   - **Privacy Level:** **Public** — so name + email are sent (needed for provisioning /
     link-by-email; otherwise trinket synthesizes a placeholder email).
   - **Custom Fields:** `trinket_course=<a trinket course id>` (one `name=value` per line; literal
     value — *not* a Canvas `$Canvas.…` substitution, which would give Canvas's id, not trinket's).
   - **Placements:** add **Course Navigation** (a course-level launch). Assignment/Link Selection
     can come later.
3. **Save.** In the Developer Keys list the key now shows a **Client ID** (a ~10–18 digit number in
   the Details column) — copy it. Toggle the key **ON**.

### B. Install the tool → get the deployment_id

1. **Admin → Settings → Apps → + App** (or Course → Settings → Apps for a single course).
2. **Configuration Type: By Client ID** → paste the **Client ID** → Submit → Install.
3. Open the installed app's **gear → Deployment Id** and copy the **Deployment ID**.

### C. Canvas platform endpoints (hosted Canvas — fixed)

- **Issuer (`iss`):** `https://canvas.instructure.com`  *(Canvas uses this same issuer for all
  hosted instances — they differ only by client_id/deployment, which is why trinket matches on
  both `iss` + `client_id`.)*
- **OIDC auth URL:** `https://sso.canvaslms.com/api/lti/authorize_redirect`
- **JWKS URL:** `https://sso.canvaslms.com/api/lti/security/jwks`
- **Token URL (later, for AGS):** `https://sso.canvaslms.com/login/oauth2/token`

(Self-hosted/local Canvas: substitute your Canvas domain; older instances may still use
`canvas.instructure.com` for these. Confirm against your Canvas's LTI config if a launch fails.)

### D. Seed trinket, then launch

```bash
node scripts/seed-lti-platform.js \
  --issuer "https://canvas.instructure.com" \
  --client-id "<the long Client ID from A3>" \
  --auth-login-url "https://sso.canvaslms.com/api/lti/authorize_redirect" \
  --jwks-url "https://sso.canvaslms.com/api/lti/security/jwks" \
  --deployment-id "<Deployment ID from B3>" \
  --name "Canvas"
```

Then open a Canvas course where the tool is installed and click **trinket** in Course Navigation.
trinket signs you in (Teacher/TA/Designer → `course-admin`, Student → `course-student`), enrolls
you, and lands you on the trinket course. Each Canvas *instance* is its own `LtiPlatform` record
(same issuer, different client_id).
