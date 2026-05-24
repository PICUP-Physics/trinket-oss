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
