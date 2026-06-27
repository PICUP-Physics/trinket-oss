# trinket-uindy — deployment setup state & remaining steps

A UIndy-specific Cloud Run / Firestore deployment of trinket, cloned from trinket-gcr.
Deployment config lives on the **`uindy`** branch (shared origin `sspickle/trinket-oss`).

## Provisioned (done)

| Item | Value |
|---|---|
| GCP project | `trinket-uindy` (number `349223059011`), ACTIVE |
| Billing | `01BE53-E6E236-35F5A8` ("2025 DS Instructor"), linked |
| GCS buckets | `trinket-uindy-materials`, `trinket-uindy-user-assets`, `trinket-uindy-snapshots` (us-central1, UBLA) |
| Firebase | Firebase added; Web app `1:349223059011:web:16ffb37e593086c21fdef6`; config in `.env` |
| Config | `production-cloudrun.yaml` → uindy buckets, `auth.firebase.projectId: trinket-uindy`, `lti.instructorAuthority: default` |
| `.env` (gitignored) | `GOOGLE_CLOUD_PROJECT`, region us-central1, `SESSION_PASSWORD`, fresh LTI key (`kid OuFzSM980UWhB8nVVwnp5HvXYbKEIA7Xs_5QEjmUao8`), `FIREBASE_CLIENT_CONFIG` |
| IAM | `stevespicklemire@gmail.com` granted Editor + Firebase Admin (Owner blocked by org policy `ORG_MUST_INVITE_EXTERNAL_OWNERS`) |

**Still empty in `.env`:** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (optional — see below).

## To deploy

```bash
cd ~/Development/glow-repos/trinket-uindy   # on branch `uindy`
./deploy-cloudrun.sh                         # press Enter to skip the OAuth client prompt
```
The script (idempotent) enables APIs, creates the Firestore Native DB, builds the image via
Cloud Build, stores secrets, grants datastore.user + secret-accessor to the Cloud Run runtime SA,
deploys, and sets a weekly Firestore backup + a $10/mo budget alert. The active gcloud account
(`spicklemire@uindy.edu`) owns the project, so Firestore index/rule deploy works.

## Post-deploy steps

1. **Bucket IAM** (the deploy script does *not* grant bucket access). After the runtime SA exists:
   ```bash
   SA=349223059011-compute@developer.gserviceaccount.com
   for b in materials user-assets snapshots; do
     gcloud storage buckets add-iam-policy-binding gs://trinket-uindy-$b \
       --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
   done
   ```
2. **knownHosts**: capture the deployed `*.run.app` host and replace the stale matterand entries in
   `config/production-cloudrun.yaml` (lines ~17–19), then redeploy. (Harmless on a fresh DB; matters
   once content with embed URLs exists.)
3. **Firebase login**: console → Authentication → Sign-in method → **enable Google**; add the
   `*.run.app` host (and any custom domain) to **Authorized domains**.
4. **OAuth (optional, server-side passport login):** Console → APIs & Services → Credentials → create
   OAuth client (Web); redirect `https://<host>/auth/google/callback`; put the ID/secret in `.env`;
   redeploy. Skip if Firebase Google sign-in is sufficient.
5. **Site admin** (kept out of git): set the `ADMIN_EMAILS` env var in the Cloud Run console to your
   admin email as a JSON array, e.g. `["you@example.com"]`. `siteAdmin.js` prefers this env value over
   the tracked `auth.adminEmails: []`, so the admin email never lands in the repo; the deploy script
   preserves the console value across redeploys. (This deployment's intended sole admin is recorded in
   local agent memory, not here.)
6. **LTI**: tool JWKS at `https://<host>/lti/jwks`; register via Dynamic Registration per
   `LTI-REGISTRATION.md`. Instructor authority is `default` (LMS-asserted Instructor role grants
   instructor in trinket).

## Notes
- `.env`, `config/firebase-service-account.json` are gitignored — never commit. The Firebase
  `apiKey`/`appId` in `FIREBASE_CLIENT_CONFIG` are public client identifiers, not secrets.
- The LTI signing key is **fresh** (independent of trinket-gcr), so UIndy LMS registrations are
  isolated from the matterandinteractions production tool.
