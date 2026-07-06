# Trinket deployments — step by step

Every way this codebase runs, from laptop to production. Two supported
shapes (all-or-none, enforced by the startup guard):

- **self-host**: mongoose + local auth + S3-compatible storage (garage)
- **GCP**: Firestore + Firebase Auth + GCS

Related docs: `DEPLOYING.md` (staged-deploy workflow + overlay reference),
`config/deploy-dir.js` (overlay loader), `docs/GCR-PICUP-TRIAL-MERGE-NOTES.md`
(design decisions).

---

# Part I — Local development

## GCP shape, fully emulated (the closest local mirror of mandi/uindy/trials)

```bash
docker compose -f docker-compose.gcr.yml up --build
```

Runs the full Firebase emulator suite (auth + firestore + storage, project
`demo-trinket`) plus the app in GCP shape. App: http://localhost:3001,
**Emulator UI** (browse live Firestore docs + Auth accounts):
http://localhost:4000. Sign in with any invented email/password — the auth
emulator accepts everything.

- Needs `SESSION_PASSWORD` (32+ chars) and `FIREBASE_CLIENT_CONFIG` (any
  valid JSON works against the emulator) in `.env` or the shell.
- The tree is bind-mounted: view/template edits are live (reload the page);
  server-code edits need `docker compose -f docker-compose.gcr.yml restart app`.
- The compose file pins `platform: linux/arm64` (Apple Silicon). On an
  Intel machine, override with a second `-f` file setting
  `services.app.platform: linux/amd64`.

## Self-host shape (compose)

```bash
docker compose up --build       # app + mongo + redis + garage S3
```

App on :3000; backends published to the host on offset ports (mongo 17017,
redis 16379, garage 3900) so they can't collide with host installs.

## Bare node (fastest view iteration) + overlay runs

See DEPLOYING.md §"Running locally with a deploy overlay": backends via
`docker compose up mongodb redis garage-init`, then
`TRINKET_DEPLOY=<name> node app.js` with the overlay's
`local-development.yaml` pointing at the offset ports.

## The automated suites (no stack needed — self-contained)

Four profiles, run in containers; commands in
`test/firestore-emulator.Dockerfile`'s header: mongo, mongo+`TEST_S3=garage`
(real garage), firestore (`TEST_DB_BACKEND=firestore`), and
firestore+`TEST_AUTH_PROVIDER=firebase` (real Auth-emulator logins).

---

# Part II — Trial / test deployments

## rba-merge-trial.spvi.net (GCP shape, Cloud Run)

Project `trinket-merge-test` (throwaway, own budget alert). Overlay:
`deploys/trial-gcr/` (its `.env` is backed up as Secret Manager secret
`trinket-deploy-dotenv` in that project — restore with
`gcloud secrets versions access latest --secret=trinket-deploy-dotenv > deploys/trial-gcr/.env`).

Update it (staged, from this checkout on `trial/picup-plus-prs`):

```bash
TRINKET_DEPLOY=trial-gcr NO_TRAFFIC=1 bash deploy-cloudrun.sh
# verify the tagged candidate URL, then promote with the printed command
```

Custom-domain pieces (already done; recorded for rebuilds): Cloud Run
domain mapping + CNAME → ghs.googlehosted.com, the domain in Firebase
authorized domains, `PUBLIC_HOSTNAME` in the overlay `.env`.

## trial-merge.spvi.net (self-host shape, docker compose on webapps)

The reference self-hosted stack: compose (app + mongo + redis + garage)
fronted by webapps' shared prod apache; per-bucket asset hosts over the
`garage-trial` LE cert. Everything deploy-specific is in the private repo
`sspickle/test-vps-trinket-deploy` (incl. the apache vhosts + a
restore-from-scratch runbook).

Update it:

```bash
ssh steve@webapps.spvi.net
cd ~/docker/trinket-trial
git pull                          # branch: trial/picup-plus-prs
docker compose up -d --build      # code is baked into the image — rebuild required
```

---

# Part III — Production (mandi / uindy)

**Current (pre-merge) reality**: production runs the `gcr-firebase` lineage,
NOT this trial branch. Each deploy has its own worktree + branch because the
code lineage differs — this collapses to overlay-style after the merge:

| Deploy | Worktree | Branch | Overlay repo (config backup) |
|---|---|---|---|
| mandi | `../gcr-mandi` | `deploy-mandi` | `MIAuthors/trinket-deploy` |
| uindy | `../gcr-uindy` | `deploy-uindy` | `UINDY-INSTRUCTORS/uindy-trinket-deploy` |

The gitignored per-deploy files (`.env`, `config/local-production.yaml`,
branding, mandi's LTI key) live in the worktree AND in the overlay repo —
edit in the repo, copy to the worktree (or vice versa), keep both in sync.

Deploy procedure (staged; run FROM the deploy's worktree):

```bash
cd ../gcr-mandi        # or ../gcr-uindy
# 1. Land the fix on the canonical branch (gcr-firebase), then merge it in:
git merge gcr-firebase          # NEVER deploy without syncing — stale worktree ships old code
# 2. Staged deploy:
NO_TRAFFIC=1 bash deploy-cloudrun.sh
# 3. Verify the tagged URL, then promote with the printed command.
```

Gotchas:
- The pre-merge branches have no `deploys/` mechanism — they use the
  worktree-root `.env` + `local-production.yaml` directly.
- Fixes cherry-picked to `gcr-firebase` ahead of the picup merge must be
  RECORDED (see "fork carried patches" practice) so the merge doesn't lose
  or duplicate them.
- macOS: the budget step exits 127 (`timeout` missing) AFTER a successful
  deploy — judge by the revision, not the exit code.

**Post-merge future**: mandi/uindy deploy from converged main like any
other overlay deploy — `TRINKET_DEPLOY=mandi bash deploy-cloudrun.sh` from
one checkout, worktrees retired. Their overlays must then set the policy
flags (`auth.requireApprovedAccount: true`, `restrictCourseCreation: true`)
+ `auth.provider: firebase` + `db.backend: firestore`.

---

# Part IV — Standing up a NEW deployment (GCP shape)

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
