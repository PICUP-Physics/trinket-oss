# Standing up a NEW trinket deployment — step by step

The GCP-shape recipe (Cloud Run + Firestore + Firebase Auth — the all-or-none
"GCP" profile), using the `deploys/` overlay mechanism so ONE checkout drives
any number of deployments. Distilled from the mandi/uindy/rba-merge-trial
setups (2026-07). For the self-host shape (mongo/local-auth/garage via docker
compose), see the test-vps deploy repo's README instead.

Related docs: `DEPLOYING.md` (staged-deploy workflow + overlay reference),
`config/deploy-dir.js` (overlay loader), `docs/GCR-PICUP-TRIAL-MERGE-NOTES.md`
(design decisions).

---

## 1. Create the private overlay repo

One private GitHub repo per deployment. It is both the deploy config AND the
backup — nothing deploy-specific lives anywhere else. Model it on
`MIAuthors/trinket-deploy` (mandi) or `UINDY-INSTRUCTORS/uindy-trinket-deploy`:

```
<repo>/
  .env                          # deploy-tooling env (sourced by deploy-cloudrun.sh)
  config/local-production.yaml  # node-config overlay (backends, auth, policy flags)
  config/local-development.yaml # optional: bare-node dev against compose backends
  public/img/brand/logo.png     # branding (shadows stock files by path)
  views/                        # optional: template overrides (e.g. static/about.html)
  README.md
```

**Verify the repo is private before pushing secrets** (anonymous
`https://github.com/<org>/<repo>` should 404).

## 2. Clone it into the checkout

```bash
cd <trinket-oss checkout>            # trial/picup-plus-prs or, post-merge, main
git clone git@github.com:<org>/<repo>.git deploys/<name>
```

`deploys/` is gitignored; the overlay activates only when `TRINKET_DEPLOY=<name>`.

## 3. GCP + Firebase project

```bash
gcloud projects create <project-id>            # or reuse
gcloud config configurations create <name>     # keep per-deploy gcloud configs
gcloud config set project <project-id>
# link billing in the console (deploy script creates a budget alert on first deploy)

firebase projects:addfirebase <project-id>     # attach Firebase
firebase apps:create web trinket --project <project-id>
firebase apps:sdkconfig web --project <project-id>   # → FIREBASE_CLIENT_CONFIG JSON
```

In the Firebase console: **Authentication → Sign-in method** — enable
Google (and any other providers).

## 4. Fill the overlay `.env`

Keys `deploy-cloudrun.sh` reads (see its header for the full list):

```bash
GOOGLE_CLOUD_PROJECT=<project-id>
GOOGLE_CLOUD_REGION=us-central1
SERVICE_NAME=trinket
SESSION_PASSWORD=<32+ chars>
ADMIN_EMAILS=["you@example.com"]
FIREBASE_CLIENT_CONFIG={"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}
LTI_PRIVATE_KEY=<PEM or base64-PEM>   # optional; scripts/generate-lti-keypair.js
PUBLIC_HOSTNAME=                      # EMPTY until the custom domain exists (step 7)
```

And the overlay `config/local-production.yaml` sets the GCP shape + policy:

```yaml
db:      { backend: firestore }
auth:    { provider: firebase, requireApprovedAccount: true, restrictCourseCreation: true }
storage: { backend: gcs }
```

(The startup shape-guard fails closed in production on crossed shapes —
firestore requires Firebase Auth, all-or-none.)

## 5. First deploy

```bash
TRINKET_DEPLOY=<name> bash deploy-cloudrun.sh     # NO NO_TRAFFIC on the very first run
```

The script: builds via Cloud Build → Artifact Registry, pushes
SESSION_PASSWORD / OAuth pair / LTI key into **Secret Manager**, ensures
Firestore + budget alert, deploys, and bakes `deploys/<name>/` into the image
(config/views/branding ride along; `.gcloudignore` keeps the overlay `.env`
out of Cloud Build).

Known cosmetic bug: on macOS the budget step exits 127 (`timeout` missing)
AFTER a fully successful deploy — check the revision, not the exit code.

Every later deploy uses the staged workflow (`NO_TRAFFIC=1`, verify tagged
URL, promote) — see `DEPLOYING.md`.

## 6. Sanity checks

- Service URL serves the login page (FirebaseUI renders).
- Cloud Run logs show the startup check passing (`DB: firestore ✓`).
- Sign in, create a trinket, see it in My Trinkets.
- Set `ADMIN_EMAILS` is respected (your account has admin).

## 7. Custom domain

1. **Domain mapping**:
   `gcloud beta run domain-mappings create --service trinket --domain <host> --region <region>`
   (first time: verify domain ownership when prompted).
2. **DNS**: CNAME `<host>` → `ghs.googlehosted.com.` (Google provisions the
   cert automatically; takes minutes–an hour. `curl -sI https://<host>/`
   until 200).
3. **Firebase authorized domains**: Console → Authentication → Settings →
   Authorized domains → add `<host>` (sign-in popups are rejected otherwise).
4. **App identity**: set `PUBLIC_HOSTNAME=<host>` in the overlay `.env` —
   this drives every absolute URL the app generates (redirects, share/email
   links, LTI endpoint URLs). Then a staged redeploy:
   ```bash
   TRINKET_DEPLOY=<name> NO_TRAFFIC=1 bash deploy-cloudrun.sh
   # verify the tagged URL, then promote (command printed by the script)
   ```
5. **LTI**: platform registrations bake tool URLs at registration time — any
   LMS registered against the old hostname keeps working there, but register
   fresh (via `/lti/connect`) for the new hostname.

## 8. Back up the `.env` to Secret Manager

The yaml/branding/views are backed up by the overlay repo itself. If you'd
rather keep the `.env` out of git entirely, store it as one secret:

```bash
gcloud secrets create trinket-deploy-dotenv --replication-policy=automatic --project <project-id>
gcloud secrets versions add trinket-deploy-dotenv --data-file=deploys/<name>/.env --project <project-id>
# restore on any machine:
gcloud secrets versions access latest --secret=trinket-deploy-dotenv --project <project-id> > deploys/<name>/.env
```

**Push a new version whenever the `.env` changes** (e.g. setting
PUBLIC_HOSTNAME in step 7).

## 9. Ongoing

- Deploys: staged workflow from `DEPLOYING.md`, always
  `TRINKET_DEPLOY=<name>` from one up-to-date checkout — no per-deploy
  worktrees or branches needed.
- Config changes: edit in the overlay repo → commit/push there → redeploy.
- Local dev against this deploy's branding/views:
  `TRINKET_DEPLOY=<name> node app.js` (see DEPLOYING.md "Running locally
  with a deploy overlay").
