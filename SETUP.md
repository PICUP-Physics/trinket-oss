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

---

## Files to get from Steve

| File | Where it goes |
|------|--------------|
| `.env` | repo root |
| `config/local.yaml` | `config/local.yaml` |
| `config/firebase-service-account.json` | `config/firebase-service-account.json` |

Both files are gitignored and must be shared out-of-band (1Password, encrypted
email, etc.). Never commit them.

---

## Firestore connection modes

### Mode A — Shared Firestore (recommended for development)

Connects directly to the real `trinket-gcr-test` Firestore project using the
service account key. All developers see the same data.

**`config/local.yaml`** — use the real project and key:
```yaml
db:
  backend: firestore
  firestore:
    projectId: trinket-gcr-test
    keyFilename: config/firebase-service-account.json
  redis:
    enabled: false
```

**`docker-compose.yml`** — comment out the emulator line:
```yaml
# FIRESTORE_EMULATOR_HOST: host.docker.internal:8080
```

Then build and run:
```bash
docker-compose build
docker-compose up
```

### Mode B — Local emulator (isolated, empty database)

Useful for experiments that shouldn't touch shared data. Requires the
Firebase CLI.

```bash
npm install -g firebase-tools
firebase emulators:start --only firestore --project demo-trinket
```

**`config/local.yaml`** — point at the local emulator project:
```yaml
db:
  backend: firestore
  firestore:
    projectId: demo-trinket
  redis:
    enabled: false
```

**`docker-compose.yml`** — ensure the emulator line is uncommented:
```yaml
FIRESTORE_EMULATOR_HOST: host.docker.internal:8080
```

The emulator UI is at http://localhost:4000.

---

## Full `config/local.yaml` reference

```yaml
app:
  url:
    protocol: http
    hostname: localhost
    port: 3000

  plugins:
    session:
      cookieOptions:
        password: 'same-value-as-SESSION_PASSWORD-in-.env'
        domain: ''
        isSecure: false

db:
  backend: firestore
  firestore:
    projectId: trinket-gcr-test          # or demo-trinket for emulator mode
    keyFilename: config/firebase-service-account.json  # omit for emulator mode
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

---

## Running tests

No live Firestore connection needed:

```bash
npm test
# or just the Firestore adapter:
npx mocha test/lib/db/firestore-backend.js
```

---

## Admin access

Add your email to `auth.adminEmails` in `config/local.yaml` and to
`ADMIN_EMAILS` in `.env`, then restart the container. This controls who
can assign the "Associate" role in course management.

---

## Deploying to Cloud Run

See the comments at the top of `deploy-cloudrun.sh`. The short version:

```bash
export GOOGLE_CLOUD_PROJECT=your-gcp-project-id
export SESSION_PASSWORD='...'
./deploy-cloudrun.sh
```

`ADMIN_EMAILS` and `FIREBASE_CLIENT_CONFIG` are managed as Cloud Run
environment variables in the GCP console — the deploy script does not
overwrite them, so console edits survive redeployment.
