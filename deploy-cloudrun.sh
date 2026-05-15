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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck source=.env
  source "${SCRIPT_DIR}/.env"
fi

GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT in .env or the environment}"

if [[ -z "${SESSION_PASSWORD:-}" ]]; then
  read -r -s -p "SESSION_PASSWORD (min 32 chars): " SESSION_PASSWORD
  echo
fi
if [[ ${#SESSION_PASSWORD} -lt 32 ]]; then
  echo "Error: SESSION_PASSWORD must be at least 32 characters" >&2
  exit 1
fi

GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-trinket}"
REPO_NAME="${REPO_NAME:-trinket}"
MEMORY="${MEMORY:-512Mi}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
SECRET_NAME="trinket-session-password"
IMAGE="${GOOGLE_CLOUD_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/${REPO_NAME}/${SERVICE_NAME}"

echo "=== Deploying Trinket to Cloud Run ==="
echo "Project:  ${GOOGLE_CLOUD_PROJECT}"
echo "Region:   ${GOOGLE_CLOUD_REGION}"
echo "Service:  ${SERVICE_NAME}"
echo "Image:    ${IMAGE}"
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
gcloud firestore databases describe \
  --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null \
|| gcloud firestore databases create \
  --location="${GOOGLE_CLOUD_REGION}" \
  --type=firestore-native \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

# Create or update the session password secret
echo "--- Storing session password in Secret Manager ---"
if gcloud secrets describe "${SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
  echo "${SESSION_PASSWORD}" | gcloud secrets versions add "${SECRET_NAME}" \
    --data-file=- \
    --project="${GOOGLE_CLOUD_PROJECT}"
else
  echo "${SESSION_PASSWORD}" | gcloud secrets create "${SECRET_NAME}" \
    --data-file=- \
    --replication-policy=automatic \
    --project="${GOOGLE_CLOUD_PROJECT}"
fi

# Grant IAM roles to the Cloud Run compute SA
echo "--- Granting IAM roles ---"
PROJECT_NUMBER=$(gcloud projects describe "${GOOGLE_CLOUD_PROJECT}" --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/datastore.user" \
  --quiet

gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

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

# Configure Docker auth for Artifact Registry
echo "--- Configuring Docker auth ---"
gcloud auth configure-docker "${GOOGLE_CLOUD_REGION}-docker.pkg.dev" --quiet

# Build and push with Cloud Build
echo "--- Building image with Cloud Build ---"
gcloud builds submit \
  --tag="${IMAGE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

# Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"
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
  --set-env-vars="NODE_ENV=production,NODE_APP_INSTANCE=cloudrun,GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}" \
  --set-secrets="SESSION_PASSWORD=${SECRET_NAME}:latest" \
  --quiet

# Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format='value(status.url)')

# Patch NODE_CONFIG with the service hostname
echo "--- Patching NODE_CONFIG with service hostname ---"
HOSTNAME=$(echo "${SERVICE_URL}" | sed 's|https://||')
gcloud run services update "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --set-env-vars="NODE_ENV=production,NODE_APP_INSTANCE=cloudrun,GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},NODE_CONFIG={\"app\":{\"url\":{\"hostname\":\"${HOSTNAME}\"}}}" \
  --quiet

echo ""
echo "=== Deployment complete ==="
echo "URL: ${SERVICE_URL}"
