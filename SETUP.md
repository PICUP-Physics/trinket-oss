# Development Setup (GCR / Firebase fork)

This branch (`gcr-firebase`) runs Trinket on **Google Cloud Run** with
**Firestore** as the database and **Firebase Authentication** for login.
It does not require MongoDB or Redis.

## Branch overview

| Branch | Purpose |
|--------|---------|
| `cloud-run-deploy` | Firestore adapter, GCR deploy scripts — shareable, no auth secrets |
| `gcr-firebase` | Firebase auth UI and config on top of `cloud-run-deploy` |

Day-to-day development happens on `gcr-firebase`. `cloud-run-deploy` is
the base; `gcr-firebase` is kept rebased on top of it.

---

## Prerequisites

| Tool | Install |
|------|---------|
| Docker Desktop | https://www.docker.com/products/docker-desktop |
| Node.js 20 | https://nodejs.org (only needed to run tests locally) |
| Firebase CLI | `npm install -g firebase-tools` |
| gcloud CLI | https://cloud.google.com/sdk/docs/install (only needed for deployment) |

---

## 1. Get credentials from Steve

You need access to the Firebase project **trinket-gcr-test**. Ask Steve to:

- Add your Google account to the Firebase project (so the emulator auth works)
- Share the **Firebase web app config** — a JSON object from the Firebase
  console (Project Settings → Your apps → SDK config). It looks like:
  ```json
  {
    "apiKey": "...",
    "authDomain": "trinket-gcr-test.firebaseapp.com",
    "projectId": "trinket-gcr-test",
    ...
  }
  ```

---

## 2. Create your `.env` file

Create `.env` in the repo root (it is gitignored):

```bash
# Required — any string of 32+ random characters
SESSION_PASSWORD='change-this-to-a-secure-password-min-32-chars'

# Required — the Firebase web app config JSON (single line, single-quoted)
FIREBASE_CLIENT_CONFIG='{"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}'

# Optional — your email, to get admin access in development
ADMIN_EMAILS='["you@example.com"]'

# Optional — Google OAuth (only needed if testing the Google login flow)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

---

## 3. Create `config/local.yaml`

```yaml
app:
  url:
    protocol: http
    hostname: localhost
    port: 3000

  plugins:
    session:
      cookieOptions:
        password: 'change-this-to-a-secure-password-min-32-chars'
        domain: ''
        isSecure: false

db:
  backend: firestore
  firestore:
    projectId: demo-trinket
  redis:
    enabled: false

auth:
  adminEmails:
    - you@example.com
  firebase:
    projectId: trinket-gcr-test
    clientConfig:
      apiKey: "..."
      authDomain: "trinket-gcr-test.firebaseapp.com"
      projectId: "trinket-gcr-test"
      storageBucket: "trinket-gcr-test.firebasestorage.app"
      messagingSenderId: "..."
      appId: "..."
```

Use the same password in both `local.yaml` and `.env`.

---

## 4. Start the Firestore emulator

In a separate terminal:

```bash
firebase emulators:start --only firestore --project demo-trinket
```

The emulator runs on port **8080** by default. The Docker container is
pre-configured to connect to it at `host.docker.internal:8080`.

The emulator UI is available at http://localhost:4000 — useful for
inspecting documents while developing.

---

## 5. Build and run

```bash
# First time (or after Dockerfile / package.json changes)
docker-compose build

# Start the app
docker-compose up
```

Visit **http://localhost:3000**.

> **Note:** CSS is pre-built into the image. If you change `*.scss` files,
> run `npm run build:css` on the host and restart the container.

---

## 6. Running tests

Tests run against the Firestore backend unit tests only (no live connection
needed):

```bash
npm test
# or just the Firestore adapter tests:
npx mocha test/lib/db/firestore-backend.js
```

---

## 7. Making yourself an admin

Add your email to `ADMIN_EMAILS` in `.env` and `auth.adminEmails` in
`config/local.yaml`, then restart the container. Admin status controls
who can assign the "Associate" role in course management.

---

## 8. Deploying to Cloud Run

See the comments at the top of `deploy-cloudrun.sh` for prerequisites.
The short version:

```bash
export GOOGLE_CLOUD_PROJECT=your-gcp-project-id
export SESSION_PASSWORD='...'
./deploy-cloudrun.sh
```

`ADMIN_EMAILS` and `FIREBASE_CLIENT_CONFIG` are managed as Cloud Run
environment variables in the console — the deploy script does not
overwrite them, so console edits survive redeployment.
