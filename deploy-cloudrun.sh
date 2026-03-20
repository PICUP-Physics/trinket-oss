#!/bin/bash
set -euo pipefail

# =============================================================================
# Deploy Trinket to Google Cloud Run
# =============================================================================
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated (gcloud auth login)
#   2. A GCP project with Cloud Run and Artifact Registry APIs enabled
#   3. A MongoDB Atlas free cluster with a connection URI
#
# Usage:
#   export GCP_PROJECT=your-project-id
#   export MONGODB_URI='mongodb+srv://<user>:<password>@<cluster-host>/trinket?retryWrites=true&w=majority'
#   export SESSION_PASSWORD='your-secure-password-at-least-32-characters'
#   ./deploy-cloudrun.sh
#
# Optional:
#   export GCP_REGION=us-central1          # default: us-central1
#   export SERVICE_NAME=trinket            # default: trinket
#   export REPO_NAME=trinket               # Artifact Registry repo name

GCP_PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to your Google Cloud project ID}"
MONGODB_URI="${MONGODB_URI:?Set MONGODB_URI to your MongoDB Atlas connection string}"
SESSION_PASSWORD="${SESSION_PASSWORD:?Set SESSION_PASSWORD (min 32 chars)}"

GCP_REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-trinket}"
REPO_NAME="${REPO_NAME:-trinket}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO_NAME}/${SERVICE_NAME}"

echo "=== Deploying Trinket to Cloud Run ==="
echo "Project:  ${GCP_PROJECT}"
echo "Region:   ${GCP_REGION}"
echo "Service:  ${SERVICE_NAME}"
echo "Image:    ${IMAGE}"
echo ""

# Ensure required APIs are enabled
echo "--- Enabling required APIs ---"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${GCP_PROJECT}" \
  --quiet

# Create Artifact Registry repo if it doesn't exist
echo "--- Ensuring Artifact Registry repository ---"
gcloud artifacts repositories describe "${REPO_NAME}" \
  --location="${GCP_REGION}" \
  --project="${GCP_PROJECT}" 2>/dev/null \
|| gcloud artifacts repositories create "${REPO_NAME}" \
  --repository-format=docker \
  --location="${GCP_REGION}" \
  --project="${GCP_PROJECT}" \
  --quiet

# Configure Docker auth for Artifact Registry
echo "--- Configuring Docker auth ---"
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet

# Build and push with Cloud Build
echo "--- Building image with Cloud Build ---"
gcloud builds submit \
  --tag="${IMAGE}" \
  --project="${GCP_PROJECT}" \
  --quiet

# Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --set-env-vars="NODE_ENV=cloudrun,MONGODB_URI=${MONGODB_URI},SESSION_PASSWORD=${SESSION_PASSWORD}" \
  --quiet

# Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${GCP_REGION}" \
  --project="${GCP_PROJECT}" \
  --format='value(status.url)')

echo ""
echo "=== Deployment complete ==="
echo "URL: ${SERVICE_URL}"
echo ""
echo "Next steps:"
echo "  1. Update config/cloudrun.yaml app.url.hostname with your Cloud Run URL"
echo "  2. In MongoDB Atlas, add 0.0.0.0/0 to Network Access (or use VPC connector)"
echo "  3. Visit ${SERVICE_URL} to verify"
