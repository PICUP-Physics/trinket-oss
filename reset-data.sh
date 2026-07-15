#!/bin/bash
set -euo pipefail

# =============================================================================
# Reset all user data before going live.
# Wipes Firestore (all collections) and GCS storage buckets.
# Safe to run multiple times; skips buckets that don't exist.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  source "${SCRIPT_DIR}/.env"
fi

GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT in .env or the environment}"

GCS_BUCKETS=(
  trinket-materials
  trinket-user-assets
  trinket-snapshots
)

echo "=== Data reset for project: ${GOOGLE_CLOUD_PROJECT} ==="
echo ""
echo "This will permanently delete:"
echo "  - All Firestore documents (all collections)"
for b in "${GCS_BUCKETS[@]}"; do
  echo "  - gs://${b}/ (if it exists)"
done
echo ""
read -r -p "Type the project ID to confirm: " CONFIRM
if [[ "${CONFIRM}" != "${GOOGLE_CLOUD_PROJECT}" ]]; then
  echo "Aborted."
  exit 1
fi

read -r -p "Are you sure? Type 'yes' to proceed: " SURE
if [[ "${SURE}" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "--- Deleting all Firestore documents ---"
firebase firestore:delete \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --all-collections \
  --force

echo ""
echo "--- Deleting GCS bucket contents ---"
for BUCKET in "${GCS_BUCKETS[@]}"; do
  if gsutil ls "gs://${BUCKET}/" &>/dev/null; then
    echo "    Clearing gs://${BUCKET}/"
    gsutil -m rm -r "gs://${BUCKET}/**" || true
  else
    echo "    gs://${BUCKET}/ not found — skipping"
  fi
done

echo ""
echo "=== Reset complete ==="
