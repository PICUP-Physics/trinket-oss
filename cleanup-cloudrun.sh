#!/bin/bash
set -euo pipefail

# =============================================================================
# Clean up old Cloud Run revisions and Artifact Registry images,
# keeping the most recent KEEP_COUNT of each.
# =============================================================================
#
# Usage:
#   ./cleanup-cloudrun.sh
#
# Optional:
#   export KEEP_COUNT=3           # revisions/images to keep (default: 3)
#   export SERVICE_NAME=trinket   # Cloud Run service name (default: trinket)
#   export REPO_NAME=trinket      # Artifact Registry repo name (default: trinket)
#   export DRY_RUN=1              # print what would be deleted without deleting

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: cleanup-cloudrun.sh

Delete old Cloud Run revisions and Artifact Registry images,
keeping the most recent KEEP_COUNT of each.

Required (set in .env or environment):
  GOOGLE_CLOUD_PROJECT     GCP project ID

Optional:
  KEEP_COUNT               Number of revisions/images to keep (default: 3)
  SERVICE_NAME             Cloud Run service name (default: trinket)
  REPO_NAME                Artifact Registry repo name (default: trinket)
  GOOGLE_CLOUD_REGION      Region (default: us-central1)
  DRY_RUN                  Set to 1 to print what would be deleted without deleting
EOF
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  source "${SCRIPT_DIR}/.env"
fi

GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT in .env or the environment}"
GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-trinket}"
REPO_NAME="${REPO_NAME:-trinket}"
KEEP_COUNT="${KEEP_COUNT:-3}"
DRY_RUN="${DRY_RUN:-0}"
IMAGE_PATH="${GOOGLE_CLOUD_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/${REPO_NAME}/${SERVICE_NAME}"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "--- DRY RUN — nothing will be deleted ---"
fi

echo "Project: ${GOOGLE_CLOUD_PROJECT}"
echo "Region:  ${GOOGLE_CLOUD_REGION}"
echo "Service: ${SERVICE_NAME}"
echo "Keeping last ${KEEP_COUNT} revisions and images"
echo ""

# ---------------------------------------------------------------------------
# Cloud Run revisions
# ---------------------------------------------------------------------------
echo "=== Cloud Run revisions ==="

# List all revisions sorted newest-first; skip the header line
ALL_REVISIONS=$(gcloud run revisions list \
  --service="${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --sort-by="~metadata.creationTimestamp" \
  --format="value(metadata.name)" 2>/dev/null || true)

if [[ -z "${ALL_REVISIONS}" ]]; then
  echo "No revisions found."
else
  REVISION_COUNT=0
  while IFS= read -r revision; do
    REVISION_COUNT=$((REVISION_COUNT + 1))
    if [[ ${REVISION_COUNT} -le ${KEEP_COUNT} ]]; then
      echo "  keeping  ${revision}"
    else
      echo "  deleting ${revision}"
      if [[ "${DRY_RUN}" != "1" ]]; then
        gcloud run revisions delete "${revision}" \
          --region="${GOOGLE_CLOUD_REGION}" \
          --project="${GOOGLE_CLOUD_PROJECT}" \
          --quiet 2>/dev/null || echo "    (skipped — may be serving traffic)"
      fi
    fi
  done <<< "${ALL_REVISIONS}"
fi

echo ""

# ---------------------------------------------------------------------------
# Artifact Registry images
# ---------------------------------------------------------------------------
echo "=== Artifact Registry images ==="

# List digests sorted newest-first
ALL_DIGESTS=$(gcloud artifacts docker images list "${IMAGE_PATH}" \
  --format="value(createTime,version)" \
  --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null \
  | grep -v "^Listing" | sort -r | awk '{print $2}' || true)

if [[ -z "${ALL_DIGESTS}" ]]; then
  echo "No images found."
else
  IMAGE_COUNT=0
  while IFS= read -r digest; do
    [[ -z "${digest}" ]] && continue
    IMAGE_COUNT=$((IMAGE_COUNT + 1))
    if [[ ${IMAGE_COUNT} -le ${KEEP_COUNT} ]]; then
      echo "  keeping  ${digest:0:19}..."
    else
      echo "  deleting ${digest:0:19}..."
      if [[ "${DRY_RUN}" != "1" ]]; then
        gcloud artifacts docker images delete \
          "${IMAGE_PATH}@${digest}" \
          --delete-tags \
          --async \
          --project="${GOOGLE_CLOUD_PROJECT}" \
          --quiet 2>/dev/null || echo "    (skipped)"
      fi
    fi
  done <<< "${ALL_DIGESTS}"
fi

echo ""
echo "=== Done ==="
