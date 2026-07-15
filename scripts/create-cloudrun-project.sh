#!/bin/bash
set -euo pipefail

# =============================================================================
# Create a fresh Google Cloud project for Trinket Cloud Run deployments.
# =============================================================================
#
# Required:
#   export NEW_GOOGLE_CLOUD_PROJECT=your-new-project-id
#
# Optional:
#   export GOOGLE_CLOUD_REGION=us-central1
#   export FIRESTORE_LOCATION=nam5
#   export BILLING_ACCOUNT_ID=000000-000000-000000
#   export PROJECT_NAME="Trinket OSS"
#   export FOLDER_ID=1234567890
#   export ORGANIZATION_ID=1234567890
#   export WRITE_ENV=1                    # write .env.cloudrun-new-project
#
# Examples:
#   NEW_GOOGLE_CLOUD_PROJECT=trinket-oss-dev-123 bash scripts/create-cloudrun-project.sh
#   NEW_GOOGLE_CLOUD_PROJECT=trinket-oss-dev-123 BILLING_ACCOUNT_ID=ABCDEF-123456-789ABC bash scripts/create-cloudrun-project.sh

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: create-cloudrun-project.sh

Create a fresh Google Cloud project configured for Trinket Cloud Run deployments.
Enables required APIs and creates a Firestore Native database.

Required:
  NEW_GOOGLE_CLOUD_PROJECT   New GCP project ID

Optional:
  GOOGLE_CLOUD_REGION        Cloud Run region (default: us-central1)
  FIRESTORE_LOCATION         Firestore multi-region location (default: nam5)
  BILLING_ACCOUNT_ID         Billing account to link (e.g. 000000-000000-000000)
  PROJECT_NAME               Human-readable display name (default: project ID)
  FOLDER_ID                  Parent folder ID
  ORGANIZATION_ID            Parent organization ID
  WRITE_ENV                  Set to 1 to write .env.cloudrun-new-project

Examples:
  NEW_GOOGLE_CLOUD_PROJECT=trinket-oss-dev-123 bash scripts/create-cloudrun-project.sh
  NEW_GOOGLE_CLOUD_PROJECT=myproject BILLING_ACCOUNT_ID=ABCDEF-123456-789ABC bash scripts/create-cloudrun-project.sh
EOF
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${REPO_DIR}/.env" ]]; then
  # shellcheck source=.env
  source "${REPO_DIR}/.env"
fi

PROJECT_ID="${NEW_GOOGLE_CLOUD_PROJECT:?Set NEW_GOOGLE_CLOUD_PROJECT to the new project id}"
PROJECT_NAME="${PROJECT_NAME:-${PROJECT_ID}}"
GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
WRITE_ENV="${WRITE_ENV:-false}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI is not installed or not on PATH" >&2
  exit 1
fi

echo "=== Creating Trinket Cloud Run GCP project ==="
echo "Project ID:         ${PROJECT_ID}"
echo "Project name:       ${PROJECT_NAME}"
echo "Cloud Run region:   ${GOOGLE_CLOUD_REGION}"
echo "Firestore location: ${FIRESTORE_LOCATION}"
echo ""

CREATE_ARGS=("${PROJECT_ID}" "--name=${PROJECT_NAME}")
if [[ -n "${FOLDER_ID:-}" ]]; then
  CREATE_ARGS+=("--folder=${FOLDER_ID}")
elif [[ -n "${ORGANIZATION_ID:-}" ]]; then
  CREATE_ARGS+=("--organization=${ORGANIZATION_ID}")
fi

if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "--- Project already exists ---"
else
  echo "--- Creating project ---"
  gcloud projects create "${CREATE_ARGS[@]}"
fi

if [[ -n "${BILLING_ACCOUNT_ID:-}" ]]; then
  echo "--- Linking billing account ---"
  gcloud billing projects link "${PROJECT_ID}" \
    --billing-account="${BILLING_ACCOUNT_ID}"
else
  BILLING_ENABLED=$(gcloud billing projects describe "${PROJECT_ID}" \
    --format='value(billingEnabled)' 2>/dev/null || true)
  if [[ "${BILLING_ENABLED}" != "True" ]]; then
    echo "--- Billing is not linked ---"
    echo "Set BILLING_ACCOUNT_ID to link billing automatically. Available accounts:"
    gcloud billing accounts list || true
    echo ""
    echo "Re-run with BILLING_ACCOUNT_ID set before enabling Cloud Run/Cloud Build APIs." >&2
    exit 1
  fi
fi

echo "--- Setting gcloud project ---"
gcloud config set project "${PROJECT_ID}"

echo "--- Enabling required APIs ---"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

echo "--- Ensuring Firestore Native database ---"
DB_TYPE=$(gcloud firestore databases describe \
  --project="${PROJECT_ID}" \
  --format='value(type)' 2>/dev/null || true)

if [[ -z "${DB_TYPE}" ]]; then
  gcloud firestore databases create \
    --location="${FIRESTORE_LOCATION}" \
    --type=firestore-native \
    --project="${PROJECT_ID}" \
    --quiet
elif [[ "${DB_TYPE}" == "FIRESTORE_NATIVE" ]]; then
  echo "Firestore database already exists in Native mode."
else
  echo "Error: project ${PROJECT_ID} already has a default database in ${DB_TYPE}." >&2
  echo "Create a different project for this Firestore Native deployment." >&2
  exit 1
fi

if [[ "${WRITE_ENV}" =~ ^(1|true|yes)$ ]]; then
  ENV_FILE="${REPO_DIR}/.env.cloudrun-new-project"
  cat > "${ENV_FILE}" <<EOF
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}
GOOGLE_CLOUD_REGION=${GOOGLE_CLOUD_REGION}
SERVICE_NAME=trinket
REPO_NAME=trinket
MEMORY=512Mi
MAX_INSTANCES=10
EOF
  echo "--- Wrote ${ENV_FILE} ---"
  echo "Copy these values into .env before running deploy-cloudrun.sh."
fi

echo ""
echo "=== Project ready ==="
echo "Next steps:"
echo "  1. Set GOOGLE_CLOUD_PROJECT=${PROJECT_ID} in .env"
echo "  2. Set SESSION_PASSWORD in .env if it is not already set"
echo "  3. Run: bash deploy-cloudrun.sh"
