# Deploying to Cloud Run

All deploys go through `./deploy-cloudrun.sh`. The script handles building the
image with Cloud Build, pushing it to Artifact Registry, ensuring Firestore /
Secret Manager are configured, and rolling out a new Cloud Run revision.

This document covers two workflows:

1. **Staged deploy** — deploy a new revision with 0% traffic, test it at a
   tagged URL, then promote when ready. **Use this by default.**
2. **Direct redeploy** — replace the live revision in one step, no testing
   window. Only use when the site is already broken and you need to ship a
   fix immediately.

---

## Prerequisites

Both workflows assume:

- `gcloud` CLI installed and logged in (`gcloud auth login`).
- `.env` in the repo root with at least:
  ```
  GOOGLE_CLOUD_PROJECT=trinket-gcr-test
  FIREBASE_CLIENT_CONFIG={"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}
  SESSION_PASSWORD=<at least 32 characters>
  ```
- The service has been deployed at least once already (for staged deploys —
  see "First-time deploy" below if not).
- The git working tree has the changes you want to ship.

`ADMIN_EMAILS` is managed in the Cloud Run console and is preserved across
deploys automatically. Don't put it in `.env`.

### Editing `ADMIN_EMAILS` (or any service env var) — the traffic-pinning trap

`ADMIN_EMAILS` is a JSON array read by `lib/util/siteAdmin.js` from the
`ADMIN_EMAILS` env var; it seeds the site-admin allowlist AND auto-approves
those addresses at the signup gate (`instructorAuth.isApprovedToSignup`).

**The trap:** after a staged deploy you promote with
`update-traffic --to-tags candidate=100`, which *pins* traffic to that
tagged revision. A later `gcloud run services update --update-env-vars`
creates a NEW revision with the changed var but gives it **zero traffic** —
so the change is live in the revision list yet the running site still serves
the old value. Symptom: you edit `ADMIN_EMAILS`, but the person still hits
"not on a course roster" / lacks admin.

**Do one of these instead:**
- **Cloud Run console → Edit & Deploy New Revision → Variables** — the UI
  shifts traffic to the new revision for you. Simplest.
- **CLI, then shift traffic explicitly:**
  ```bash
  # JSON arrays have commas, so pass via a flags-file (--update-env-vars
  # mis-splits on the commas otherwise):
  #   flags.yaml:
  #     --update-env-vars:
  #       ADMIN_EMAILS: '["a@x.com","b@y.com"]'
  gcloud run services update trinket --flags-file=flags.yaml \
    --project <proj> --region us-central1
  # then move traffic to the revision the update just created:
  gcloud run services update-traffic trinket --to-revisions=<new-rev>=100 \
    --project <proj> --region us-central1
  ```
- **Re-run the deploy script** (it promotes as part of the flow).

No caching is involved — `isAdminEmail` reads the env on every call. If the
serving revision has the value, it's effective immediately.

---

## Workflow 1: Staged deploy (recommended)

Steps at a glance:

1. Deploy a new revision with `NO_TRAFFIC=1`. 100% of live traffic stays on
   the previous revision.
2. Open the tagged URL the script prints. Verify the change.
3. Promote the tagged revision to 100% traffic.
4. If something is wrong, point traffic back at the previous revision.

### 1. Deploy with no traffic

```bash
NO_TRAFFIC=1 ./deploy-cloudrun.sh
```

The script will:

- Build the image (skip with `SKIP_BUILD=1` to reuse the last built image).
- Create a new Cloud Run revision with `--no-traffic --tag=candidate`.
- Print two URLs at the end:
  - **Tagged URL** — `https://candidate---trinket-<hash>-uc.a.run.app`,
    routes only to the new revision.
  - **Prod URL** — unchanged, still serving the previous revision.

The previous revision continues to serve all real users while you test.

### 2. Test the tagged URL

Open the tagged URL the script printed. Things to check:

- The page you changed renders without errors.
- Browser DevTools → Console has no new JS errors.
- Any new server-side behavior shows up correctly in the Cloud Run logs:
  ```bash
  gcloud run services logs read trinket --region us-central1 --limit 50
  ```

**Caveat: Firebase Auth on the tagged URL.** The tagged URL is a `*.run.app`
host that is **not** in Firebase Auth's authorized domains list by default.
Sign-in popups will be rejected unless you add the tagged hostname:

1. Firebase Console → Authentication → Settings → Authorized domains.
2. Add the tagged hostname (e.g. `candidate---trinket-abc-uc.a.run.app`).

For testing that the login view *renders* (which is the common pre-launch
check), this isn't required — only the FirebaseUI widget needs to load.

**Caveat 2: signing in on the tagged URL redirects you to the PROD host.**
The post-login redirect comes from `config.url` (PUBLIC_HOSTNAME), so after
authenticating on `candidate---…run.app` you land on the regular site —
easy to miss that you're no longer testing the candidate. Navigate back to
the tagged URL after login (the session cookie is host-scoped, so you may
need to sign in once per host).

### 3. Promote to 100% traffic

When you've verified the new revision works, run the command the script
printed at the end of the deploy:

```bash
gcloud run services update-traffic trinket \
  --to-tags candidate=100 \
  --region us-central1 \
  --project trinket-gcr-test
```

This shifts all live traffic to the new revision instantly. The previous
revision is kept around (Cloud Run retains revisions until you delete them)
and is still available for rollback.

#### Optional: canary first

If the change is risky, send 10% first:

```bash
gcloud run services update-traffic trinket \
  --to-tags candidate=10 \
  --region us-central1 \
  --project trinket-gcr-test
```

Watch metrics for a few minutes, then run the same command with `=100`.

### 4. If you need to roll back

List recent revisions to find the one to roll back to:

```bash
gcloud run revisions list \
  --service trinket \
  --region us-central1 \
  --project trinket-gcr-test \
  --limit 5
```

Send traffic back to a known-good revision:

```bash
gcloud run services update-traffic trinket \
  --to-revisions trinket-00042-abc=100 \
  --region us-central1 \
  --project trinket-gcr-test
```

(Replace `trinket-00042-abc` with the previous revision's name.)

---

## Workflow 2: Direct redeploy (emergency / hotfix)

Use this when the live site is already broken and any working revision is
better than what's currently serving — there's no point staging if production
is already down.

```bash
./deploy-cloudrun.sh
```

This is the default behavior of the script. The new revision gets 100% of
traffic as soon as it passes Cloud Run's health checks. No tagged URL, no
test window.

### When to prefer this

- Site is returning 500s, syntax errors, or a blank page for everyone.
- The fix is small and you have high confidence it works locally.
- You've already tested the change locally (e.g. against the Firebase Auth
  emulator).

### What to do *while* the deploy is running

The deploy takes a few minutes (build + push + revision rollout). Use that
time to:

- Have the rollback command ready in another terminal, with the **previous
  revision name pre-filled** so you can paste-and-run instantly if needed:

  ```bash
  gcloud run revisions list \
    --service trinket \
    --region us-central1 \
    --limit 3
  # Note the current revision's name BEFORE the new one rolls out.

  # Pre-build the rollback:
  gcloud run services update-traffic trinket \
    --to-revisions <PREVIOUS_REVISION_NAME>=100 \
    --region us-central1 \
    --project trinket-gcr-test
  ```

- Keep a Cloud Run logs tail open:
  ```bash
  gcloud beta run services logs tail trinket --region us-central1
  ```

### After the deploy

Verify immediately. If the prod URL is still broken, paste the pre-built
rollback command. If the fix worked, you're done.

---

## First-time deploy

`NO_TRAFFIC=1` requires the service to already exist — there's nothing to
keep serving the previous traffic if there's no previous revision. The
script will error out clearly if you try.

For the very first deploy of a brand-new service, run the script without
`NO_TRAFFIC`:

```bash
./deploy-cloudrun.sh
```

After that, all subsequent deploys can use the staged workflow.

---

## Per-deploy customization (`deploys/`)

Everything specific to one deployment — config with secrets, branding,
custom pages — lives OUTSIDE this repo, in a private per-deploy repo cloned
into the gitignored `deploys/` folder and activated with `TRINKET_DEPLOY`:

```bash
git clone git@github.com:MIAuthors/trinket-deploy.git deploys/mandi
TRINKET_DEPLOY=mandi node app.js
```

The overlay (`config/deploy-dir.js` is the loader) has three parts, all
optional:

| Folder | Effect |
|---|---|
| `deploys/<name>/config/` | yaml files (same names node-config uses, e.g. `local-production.yaml`) deep-merged onto the loaded config — wins over everything, so keep host-specific values out |
| `deploys/<name>/views/` | nunjucks templates that shadow `lib/views/` by relative path |
| `deploys/<name>/public/` | static assets that shadow `public/` by relative path |

Without `TRINKET_DEPLOY` the app runs completely stock — the mechanism is
inert.

### Example: give your deploy its own About page

The stock page is `lib/views/static/about.html`. To replace it, add a file
at the same relative path inside your deploy repo —
`deploys/<name>/views/static/about.html`:

```html
{% extends "base.html" %}

{% block title %}About My University's Trinket{% endblock %}

{% block body_id %}about{% endblock %}

{% block content %}
<div class="row" style="padding: 40px 0;">
  <div class="small-12 columns">
    <h2>About this site</h2>
    <p class="lead">This trinket instance is run by ... for ... courses.</p>
  </div>
</div>
{% endblock %}
```

Restart the app and `/about` serves your version — no fork, no patches to
this repo. `{% extends "base.html" %}` still resolves against the stock
tree, so you inherit the site chrome (nav, login state, footer) and only
replace the page body. The same shadowing works for any template (e.g.
`views/static/help.html`) and any static asset (e.g.
`public/img/brand/logo.png`).

### Deploying to Cloud Run with a deploy overlay

`deploy-cloudrun.sh` is overlay-aware. With the overlay repo cloned into
`deploys/`, name it on the command line:

```bash
git clone git@github.com:MIAuthors/trinket-deploy.git deploys/mandi
TRINKET_DEPLOY=mandi bash deploy-cloudrun.sh            # direct
TRINKET_DEPLOY=mandi NO_TRAFFIC=1 bash deploy-cloudrun.sh   # staged (recommended)
```

What the script does with it:

1. **`deploys/mandi/.env` is sourced after the root `.env`** and overrides
   it — project id, service name, region, secrets all come from the
   overlay, so the root `.env` can stay generic (or hold a convenience
   default `TRINKET_DEPLOY=mandi`; an explicit command-line value always
   outranks it).
2. **The overlay is baked into the image** (the Dockerfile copies the whole
   tree, `deploys/` included) — changing overlay config/views means a
   redeploy, same as changing app code.
3. **`TRINKET_DEPLOY=mandi` is set on the Cloud Run service**, so the app
   activates the overlay at boot.

One checkout drives many deploys: clone several overlay repos side by side
under `deploys/` and pick per invocation —
`TRINKET_DEPLOY=uindy bash deploy-cloudrun.sh` deploys UIndy from the same
tree without touching mandi.

### Running locally with a deploy overlay

**Bare node** (fastest iteration — config, views, and assets all live-read
from the overlay folder; a nunjucks edit only needs a page reload, a config
edit a restart):

```bash
TRINKET_DEPLOY=mandi node app.js
```

You still need whatever backends the overlay's shape expects (the compose
stack's mongo/redis, or the Firebase emulators for a GCP-shape overlay).

**Docker compose** (closest to production): `docker-compose.yml` passes
`TRINKET_DEPLOY` through to the app container:

```bash
TRINKET_DEPLOY=mandi docker compose up --build
```

Note the overlay is baked into the compose image at build time just like
Cloud Run — after editing overlay files, `docker compose up --build` (or
`docker compose build app`) to pick them up. For rapid view-tweaking, prefer
bare node.

**Bare node + compose backends.** The compose stack publishes its backends
to the host on offset ports (no collision with host-installed services):
mongo `127.0.0.1:17017`, redis `127.0.0.1:16379`, garage `127.0.0.1:3900`.
A bare-node run must be pointed at them — and the right home for that is a
`config/local-development.yaml` in the overlay repo, which deploy-dir merges
ONLY when `NODE_ENV` is development (so it can never leak into prod, and
`local-production.yaml` never leaks into dev):

```yaml
# deploys/<name>/config/local-development.yaml
db:
  mongo:
    host: localhost
    port: 17017
  redis:
    app:
      port: 16379
    exports:
      port: 16379
aws:
  endpoint: http://localhost:3900
```

Then the loop is:

```bash
docker compose up mongodb redis garage-init   # backends only (garage-init pulls in garage)
TRINKET_DEPLOY=mandi node app.js              # overlay branding/views, live-reloading
```

Keep env-specific values in the env-suffixed files (`local-development.yaml`
/ `local-production.yaml`), not in `local.yaml` — `local.yaml` loads in
EVERY env, including test, and a backend setting there will poison runs that
assume stock defaults.

---

## Updating the Web VPython runtime (rsWVPRunner)

The GlowScript embed loads `glow.3.2.3.min.js` (and `RScompiler` / `RSrun`) from
`public/components/vpython-glowscript/package/`. These files come from the
`rsWVPRunner` build, pinned as version `3.2.3` in `lib/views/embed/glowscript-config.html`.

### After rebuilding rsWVPRunner (`do_build.sh`)

**Local dev** — copy the new files into the running container without a full rebuild:

```bash
npm run setup-vendor
```

Then reload your browser. The script reads `GLOWSCRIPT_PACKAGE_BUILD` from the
Dockerfile and copies from the local `rsWVPRunner/package/` tree (or falls back
to GCS if that repo isn't present).

**Deploy** — bump the cache-buster in `Dockerfile` so Cloud Build fetches the
new files from GCS instead of reusing its cached layer:

```diff
-ARG GLOWSCRIPT_PACKAGE_BUILD=2026-06-12a
+ARG GLOWSCRIPT_PACKAGE_BUILD=<today's date or build tag>
```

Then deploy normally. The `RUN curl` step in the Dockerfile fetches the three
runtime files from `gs://rswvprunner/package/` and bakes them into the image.
No extra steps needed at deploy time.

---

## Environment flags reference

| Env var                | Default       | Effect                                                    |
|------------------------|---------------|-----------------------------------------------------------|
| `NO_TRAFFIC`           | `false`       | Deploy without routing traffic; reachable via tag only.   |
| `TAG`                  | `candidate`   | Tag name applied to the no-traffic revision.              |
| `SKIP_BUILD`           | `false`       | Reuse the existing image tag; skip Cloud Build.           |
| `GOOGLE_CLOUD_REGION`  | `us-central1` | Cloud Run region.                                         |
| `SERVICE_NAME`         | `trinket`     | Cloud Run service name.                                   |
| `MEMORY`               | `512Mi`       | Container memory.                                         |
| `MAX_INSTANCES`        | `10`          | Cloud Run max instance count.                             |

Combine as needed — e.g. to redeploy without rebuilding the image and
without routing traffic:

```bash
SKIP_BUILD=1 NO_TRAFFIC=1 ./deploy-cloudrun.sh
```
