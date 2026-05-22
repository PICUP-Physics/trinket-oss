#!/bin/bash
set -euo pipefail

# =============================================================================
# Deploy Trinket to Google Cloud Run (Firestore backend, no MongoDB)
# =============================================================================
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated (gcloud auth login)
#   2. A GCP project with billing enabled
#
# Usage:
#   export GOOGLE_CLOUD_PROJECT=your-project-id
#   export SESSION_PASSWORD='your-secure-password-at-least-32-characters'
#   ./deploy-cloudrun.sh
#
# Optional:
#   export GOOGLE_CLOUD_REGION=us-central1 # default: us-central1
#   export SERVICE_NAME=trinket            # default: trinket
#   export REPO_NAME=trinket               # Artifact Registry repo name
#   export MEMORY=512Mi                    # default: 512Mi
#   export MAX_INSTANCES=10                # default: 10
#   export SKIP_BUILD=1                    # reuse the existing image tag
#   export ADMIN_EMAILS='["you@example.com"]'  # JSON array of admin emails

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck source=.env
  source "${SCRIPT_DIR}/.env"
fi

GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT in .env or the environment}"

# Validate FIREBASE_CLIENT_CONFIG is present and is valid JSON with required fields
if [[ -z "${FIREBASE_CLIENT_CONFIG:-}" ]]; then
  echo "Error: FIREBASE_CLIENT_CONFIG is not set. Add it to .env." >&2
  exit 1
fi
if ! node -e "
  var cfg;
  try { cfg = JSON.parse(process.argv[1]); } catch(e) { console.error('FIREBASE_CLIENT_CONFIG is not valid JSON: ' + e.message); process.exit(1); }
  var missing = ['apiKey','authDomain','projectId','appId'].filter(function(k){return !cfg[k];});
  if (missing.length) { console.error('FIREBASE_CLIENT_CONFIG missing fields: ' + missing.join(', ')); process.exit(1); }
" -- "${FIREBASE_CLIENT_CONFIG}" 2>&1; then
  exit 1
fi

if [[ -z "${SESSION_PASSWORD:-}" ]]; then
  read -r -s -p "SESSION_PASSWORD (min 32 chars): " SESSION_PASSWORD
  echo
fi
if [[ ${#SESSION_PASSWORD} -lt 32 ]]; then
  echo "Error: SESSION_PASSWORD must be at least 32 characters" >&2
  exit 1
fi

if [[ -z "${GOOGLE_CLIENT_ID:-}" ]]; then
  read -r -p "GOOGLE_CLIENT_ID (OAuth 2.0 client ID, blank to skip): " GOOGLE_CLIENT_ID
fi
if [[ -n "${GOOGLE_CLIENT_ID}" && -z "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  read -r -s -p "GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET
  echo
fi

GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-trinket}"
REPO_NAME="${REPO_NAME:-trinket}"
MEMORY="${MEMORY:-512Mi}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
SKIP_BUILD="${SKIP_BUILD:-false}"
SECRET_NAME="trinket-session-password"
GOOGLE_CLIENT_ID_SECRET="trinket-google-client-id"
GOOGLE_CLIENT_SECRET_SECRET="trinket-google-client-secret"
IMAGE="${GOOGLE_CLOUD_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/${REPO_NAME}/${SERVICE_NAME}"
ENV_VARS_FILE=$(mktemp "${TMPDIR:-/tmp}/trinket-cloudrun-env.XXXXXX")
cleanup() { rm -f "${ENV_VARS_FILE}"; }
trap cleanup EXIT

echo "=== Deploying Trinket to Cloud Run ==="
echo "Project:  ${GOOGLE_CLOUD_PROJECT}"
echo "Region:   ${GOOGLE_CLOUD_REGION}"
echo "Service:  ${SERVICE_NAME}"
echo "Image:    ${IMAGE}"
echo "Build:    $([[ "${SKIP_BUILD}" =~ ^(1|true|yes)$ ]] && echo "skip" || echo "run")"
echo ""

# Ensure required APIs are enabled
echo "--- Enabling required APIs ---"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

# Create Firestore Native database if it doesn't exist
echo "--- Ensuring Firestore Native database ---"
FIRESTORE_DB_TYPE=$(gcloud firestore databases describe \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format='value(type)' 2>/dev/null || true)

if [[ -z "${FIRESTORE_DB_TYPE}" ]]; then
  gcloud firestore databases create \
  --location="${GOOGLE_CLOUD_REGION}" \
  --type=firestore-native \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet
elif [[ "${FIRESTORE_DB_TYPE}" != "FIRESTORE_NATIVE" ]]; then
  echo "Error: project ${GOOGLE_CLOUD_PROJECT} has a default database in ${FIRESTORE_DB_TYPE}." >&2
  echo "This Cloud Run deployment expects Firestore Native mode." >&2
  echo "Create a fresh GCP project with Firestore Native, then update GOOGLE_CLOUD_PROJECT." >&2
  exit 1
fi

# Deploy Firestore indexes and rules via Firebase CLI
echo "--- Deploying Firestore indexes and rules ---"
if command -v firebase &>/dev/null && [[ -f "${SCRIPT_DIR}/firestore.indexes.json" ]]; then
  firebase deploy --only firestore:indexes,firestore:rules \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --account "$(gcloud config get-value account)" \
    --non-interactive
  echo "    Indexes submitted (may take 1-2 min to build in background)"
else
  echo "    Skipping: firebase CLI not found or firestore.indexes.json missing"
fi

# Create or update the session password secret
echo "--- Storing session password in Secret Manager ---"
if gcloud secrets describe "${SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
  printf '%s' "${SESSION_PASSWORD}" | gcloud secrets versions add "${SECRET_NAME}" \
    --data-file=- \
    --project="${GOOGLE_CLOUD_PROJECT}"
else
  printf '%s' "${SESSION_PASSWORD}" | gcloud secrets create "${SECRET_NAME}" \
    --data-file=- \
    --replication-policy=automatic \
    --project="${GOOGLE_CLOUD_PROJECT}"
fi

# Store Google OAuth credentials in Secret Manager (only if provided)
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  echo "--- Storing Google OAuth credentials in Secret Manager ---"
  for SECRET_PAIR in "${GOOGLE_CLIENT_ID_SECRET}:${GOOGLE_CLIENT_ID}" "${GOOGLE_CLIENT_SECRET_SECRET}:${GOOGLE_CLIENT_SECRET}"; do
    S_NAME="${SECRET_PAIR%%:*}"
    S_VALUE="${SECRET_PAIR#*:}"
    if gcloud secrets describe "${S_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
      printf '%s' "${S_VALUE}" | gcloud secrets versions add "${S_NAME}" \
        --data-file=- --project="${GOOGLE_CLOUD_PROJECT}"
    else
      printf '%s' "${S_VALUE}" | gcloud secrets create "${S_NAME}" \
        --data-file=- --replication-policy=automatic --project="${GOOGLE_CLOUD_PROJECT}"
    fi
  done
fi

# Grant IAM roles to the Cloud Run compute SA
echo "--- Granting IAM roles ---"
PROJECT_NUMBER=$(gcloud projects describe "${GOOGLE_CLOUD_PROJECT}" --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/datastore.user" \
  --quiet

for S in "${SECRET_NAME}" "${GOOGLE_CLIENT_ID_SECRET}" "${GOOGLE_CLIENT_SECRET_SECRET}"; do
  if gcloud secrets describe "${S}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
    gcloud secrets add-iam-policy-binding "${S}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --member="serviceAccount:${COMPUTE_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --quiet
  fi
done

# Create Artifact Registry repo if it doesn't exist
echo "--- Ensuring Artifact Registry repository ---"
gcloud artifacts repositories describe "${REPO_NAME}" \
  --location="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null \
|| gcloud artifacts repositories create "${REPO_NAME}" \
  --repository-format=docker \
  --location="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

if [[ "${SKIP_BUILD}" =~ ^(1|true|yes)$ ]]; then
  echo "--- Skipping image build; reusing ${IMAGE} ---"
else
  # Configure Docker auth for Artifact Registry
  echo "--- Configuring Docker auth ---"
  gcloud auth configure-docker "${GOOGLE_CLOUD_REGION}-docker.pkg.dev" --quiet

  # Build and push with Cloud Build
  echo "--- Building image with Cloud Build ---"
  gcloud builds submit \
    --tag="${IMAGE}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --quiet
fi

# Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"
cat > "${ENV_VARS_FILE}" <<YAML
NODE_ENV: production
NODE_APP_INSTANCE: cloudrun
GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT}
YAML

SECRETS_ARG="SESSION_PASSWORD=${SECRET_NAME}:latest"
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  SECRETS_ARG="${SECRETS_ARG},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID_SECRET}:latest,GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_SECRET}:latest"
fi

gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --memory="${MEMORY}" \
  --cpu=1 \
  --min-instances=0 \
  --max-instances="${MAX_INSTANCES}" \
  --env-vars-file="${ENV_VARS_FILE}" \
  --set-secrets="${SECRETS_ARG}" \
  --quiet

# Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format='value(status.url)')

# Patch NODE_CONFIG with the service hostname
echo "--- Patching NODE_CONFIG with service hostname ---"
HOSTNAME=$(echo "${SERVICE_URL}" | sed 's|https://||')
# Use --update-env-vars (not --env-vars-file) so only the named vars are
# touched and console-managed vars like ADMIN_EMAILS are preserved.
# ^|^ makes | the delimiter so JSON commas/colons in values are safe.
gcloud run services update "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --update-env-vars "^|^NODE_ENV=production|NODE_APP_INSTANCE=cloudrun|GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}|NODE_CONFIG={\"app\":{\"url\":{\"hostname\":\"${HOSTNAME}\"}}}|GOOGLE_CALLBACK_URL=https://${HOSTNAME}/auth/google/callback|FIREBASE_CLIENT_CONFIG=${FIREBASE_CLIENT_CONFIG}" \
  --quiet

echo ""
echo "=== Deployment complete ==="
echo "URL: ${SERVICE_URL}"
