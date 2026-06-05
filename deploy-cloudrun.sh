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

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: deploy-cloudrun.sh

Deploy Trinket to Google Cloud Run (Firestore backend, no MongoDB).

Required (set in .env or environment):
  GOOGLE_CLOUD_PROJECT     GCP project ID
  FIREBASE_CLIENT_CONFIG   Firebase client config JSON
  SESSION_PASSWORD         Cookie encryption password (min 32 chars; prompted if unset)

Optional:
  GOOGLE_CLOUD_REGION      Region (default: us-central1)
  SERVICE_NAME             Cloud Run service name (default: trinket)
  REPO_NAME                Artifact Registry repo name (default: trinket)
  MEMORY                   Container memory (default: 512Mi)
  MAX_INSTANCES            Max instances (default: 10)
  SKIP_BUILD               Set to 1 to reuse the existing image tag
  NO_TRAFFIC               Set to 1 to deploy without routing traffic; the new
                           revision is reachable only via its tagged URL until
                           you promote it with `gcloud run services update-traffic`
  TAG                      Tag name for no-traffic deploys (default: candidate)
  GOOGLE_CLIENT_ID         Google OAuth 2.0 client ID (prompted if unset)
  GOOGLE_CLIENT_SECRET     Google OAuth 2.0 client secret
  ROTATE_SECRETS           Set to 1 to add new Secret Manager versions even when
                           the secret already exists. Default: skip update if the
                           secret exists (avoids accumulating chargeable versions).
  MONTHLY_BUDGET           Monthly spend alert threshold in USD (default: 10).
                           A GCP budget alert is created on first deploy; billing
                           admins receive email when spend hits 50%, 90%, 100%.

Prerequisites:
  gcloud CLI installed and authenticated (gcloud auth login)
  A GCP project with billing enabled

ADMIN_EMAILS is managed in the Cloud Run console and is preserved automatically
across deployments — do not set it here.
EOF
  exit 0
fi

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
NO_TRAFFIC="${NO_TRAFFIC:-false}"
TAG="${TAG:-candidate}"
ROTATE_SECRETS="${ROTATE_SECRETS:-false}"
MONTHLY_BUDGET="${MONTHLY_BUDGET:-10}"
SECRET_NAME="trinket-session-password"
GOOGLE_CLIENT_ID_SECRET="trinket-google-client-id"
GOOGLE_CLIENT_SECRET_SECRET="trinket-google-client-secret"
IMAGE="${GOOGLE_CLOUD_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/${REPO_NAME}/${SERVICE_NAME}"
ENV_VARS_FILE=$(mktemp "${TMPDIR:-/tmp}/trinket-cloudrun-env.XXXXXX")
_LIVE_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/trinket-live-env.XXXXXX")
cleanup() { rm -f "${ENV_VARS_FILE}" "${_LIVE_ENV_FILE}"; }
trap cleanup EXIT

echo "=== Deploying Trinket to Cloud Run ==="
echo "Project:  ${GOOGLE_CLOUD_PROJECT}"
echo "Region:   ${GOOGLE_CLOUD_REGION}"
echo "Service:  ${SERVICE_NAME}"
echo "Image:    ${IMAGE}"
echo "Build:    $([[ "${SKIP_BUILD}" =~ ^(1|true|yes)$ ]] && echo "skip" || echo "run")"
echo "Traffic:  $([[ "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]] && echo "0% (tag=${TAG})" || echo "100%")"
echo ""

# Ensure required APIs are enabled
echo "--- Enabling required APIs ---"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  billingbudgets.googleapis.com \
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
# Only add a new version if the secret doesn't exist yet, or ROTATE_SECRETS=1.
# Adding versions unnecessarily accumulates active versions and exceeds the free tier.
echo "--- Storing session password in Secret Manager ---"
if gcloud secrets describe "${SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
  if [[ "${ROTATE_SECRETS}" =~ ^(1|true|yes)$ ]]; then
    printf '%s' "${SESSION_PASSWORD}" | gcloud secrets versions add "${SECRET_NAME}" \
      --data-file=- \
      --project="${GOOGLE_CLOUD_PROJECT}"
  else
    echo "    Secret already exists — skipping version update (set ROTATE_SECRETS=1 to force)"
  fi
else
  printf '%s' "${SESSION_PASSWORD}" | gcloud secrets create "${SECRET_NAME}" \
    --data-file=- \
    --replication-policy=automatic \
    --project="${GOOGLE_CLOUD_PROJECT}"
fi

# Store Google OAuth credentials in Secret Manager (only if provided)
# Same ROTATE_SECRETS guard as session password above.
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  echo "--- Storing Google OAuth credentials in Secret Manager ---"
  for SECRET_PAIR in "${GOOGLE_CLIENT_ID_SECRET}:${GOOGLE_CLIENT_ID}" "${GOOGLE_CLIENT_SECRET_SECRET}:${GOOGLE_CLIENT_SECRET}"; do
    S_NAME="${SECRET_PAIR%%:*}"
    S_VALUE="${SECRET_PAIR#*:}"
    if gcloud secrets describe "${S_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" 2>/dev/null; then
      if [[ "${ROTATE_SECRETS}" =~ ^(1|true|yes)$ ]]; then
        printf '%s' "${S_VALUE}" | gcloud secrets versions add "${S_NAME}" \
          --data-file=- --project="${GOOGLE_CLOUD_PROJECT}"
      else
        echo "    ${S_NAME} already exists — skipping (set ROTATE_SECRETS=1 to force)"
      fi
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

# Preserve ADMIN_EMAILS across redeployment.
# gcloud run deploy --env-vars-file replaces all env vars, wiping anything set
# only in the console.  Fetch the live value first so we can re-apply it in
# the --update-env-vars patch step below.  We ignore any locally-set
# ADMIN_EMAILS (e.g. from .env) intentionally — console is the source of truth.
echo "--- Fetching live service state ---"
gcloud run services describe "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format=json > "${_LIVE_ENV_FILE}" 2>/dev/null || echo '{}' > "${_LIVE_ENV_FILE}"
_LIVE_ADMIN_EMAILS=$(node -e "
  var fs = require('fs');
  var d; try { d = JSON.parse(fs.readFileSync('${_LIVE_ENV_FILE}', 'utf8')); } catch(e) { d = {}; }
  var c = d && d.spec && d.spec.template && d.spec.template.spec &&
          d.spec.template.spec.containers && d.spec.template.spec.containers[0];
  var envs = (c && c.env) || [];
  var e = envs.find(function(x){ return x.name === 'ADMIN_EMAILS'; });
  process.stdout.write(e ? e.value : '');
" 2>/dev/null || true)
[[ -n "${_LIVE_ADMIN_EMAILS}" ]] && echo "    Preserved ADMIN_EMAILS from live service"

_LIVE_SERVICE_URL=$(node -e "
  var fs = require('fs');
  var d; try { d = JSON.parse(fs.readFileSync('${_LIVE_ENV_FILE}', 'utf8')); } catch(e) { d = {}; }
  process.stdout.write((d && d.status && d.status.url) || '');
" 2>/dev/null || true)

# No-traffic mode requires the service to already exist so we can derive the
# hostname (needed for NODE_CONFIG/GOOGLE_CALLBACK_URL) before deploying.
# This lets us put every env var in the deploy call, avoiding the second
# "patch" revision that would otherwise undo --no-traffic / --tag.
if [[ "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]]; then
  if [[ -z "${_LIVE_SERVICE_URL}" ]]; then
    echo "Error: NO_TRAFFIC requires the service to already exist (no prior revision to keep serving)." >&2
    exit 1
  fi
  HOSTNAME=$(echo "${_LIVE_SERVICE_URL}" | sed 's|https://||')
fi

# Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"
cat > "${ENV_VARS_FILE}" <<YAML
NODE_ENV: production
NODE_APP_INSTANCE: cloudrun
GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT}
YAML

# Include hostname-dependent vars upfront when the URL is already known:
# NO_TRAFFIC always has the URL (required); re-deploys have _LIVE_SERVICE_URL.
# This avoids a second "patch" revision on every re-deployment.
if [[ "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]] || [[ -n "${_LIVE_SERVICE_URL}" ]]; then
  # For NO_TRAFFIC, HOSTNAME is already set above; for re-deploys, derive it now.
  if [[ ! "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]]; then
    HOSTNAME=$(echo "${_LIVE_SERVICE_URL}" | sed 's|https://||')
  fi
  HOSTNAME="${HOSTNAME}" \
  FIREBASE_CLIENT_CONFIG="${FIREBASE_CLIENT_CONFIG}" \
  _LIVE_ADMIN_EMAILS="${_LIVE_ADMIN_EMAILS}" \
  node -e "
    var h = process.env.HOSTNAME;
    var lines = [];
    lines.push('NODE_CONFIG: ' + JSON.stringify(JSON.stringify({app:{url:{hostname:h}}})));
    lines.push('GOOGLE_CALLBACK_URL: ' + JSON.stringify('https://' + h + '/auth/google/callback'));
    lines.push('FIREBASE_CLIENT_CONFIG: ' + JSON.stringify(process.env.FIREBASE_CLIENT_CONFIG));
    if (process.env._LIVE_ADMIN_EMAILS) {
      lines.push('ADMIN_EMAILS: ' + JSON.stringify(process.env._LIVE_ADMIN_EMAILS));
    }
    process.stdout.write(lines.join('\n') + '\n');
  " >> "${ENV_VARS_FILE}"
fi

SECRETS_ARG="SESSION_PASSWORD=${SECRET_NAME}:latest"
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  SECRETS_ARG="${SECRETS_ARG},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID_SECRET}:latest,GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_SECRET}:latest"
fi

DEPLOY_TRAFFIC_ARGS=()
if [[ "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]]; then
  DEPLOY_TRAFFIC_ARGS=(--no-traffic --tag="${TAG}")
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
  ${DEPLOY_TRAFFIC_ARGS[@]+"${DEPLOY_TRAFFIC_ARGS[@]}"} \
  --quiet

# Get the service URL (stable across revisions)
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format='value(status.url)')

if [[ "${NO_TRAFFIC}" =~ ^(1|true|yes)$ ]]; then
  TAGGED_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${GOOGLE_CLOUD_REGION}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --flatten=status.traffic \
    --filter="status.traffic.tag=${TAG}" \
    --format='value(status.traffic.url)' | head -1)
  echo ""
  echo "=== No-traffic deploy complete ==="
  echo "Tagged URL (test here):  ${TAGGED_URL}"
  echo "Prod URL (unchanged):    ${SERVICE_URL}"
  echo ""
  echo "Note: the tagged URL is a *.run.app host. Firebase Auth popup sign-in"
  echo "      will be rejected unless you add this hostname to Firebase's"
  echo "      authorized domains (Console > Authentication > Settings)."
  echo ""
  echo "To promote 100% traffic to this revision:"
  echo "  gcloud run services update-traffic ${SERVICE_NAME} \\"
  echo "    --to-tags ${TAG}=100 \\"
  echo "    --region ${GOOGLE_CLOUD_REGION} \\"
  echo "    --project ${GOOGLE_CLOUD_PROJECT}"
  exit 0
fi

# First-time deploy only: patch NODE_CONFIG with the hostname now that the URL
# is known. On re-deploys, hostname vars were already included above.
if [[ -z "${_LIVE_SERVICE_URL}" ]]; then
  echo "--- Patching NODE_CONFIG with service hostname (first deploy) ---"
  HOSTNAME=$(echo "${SERVICE_URL}" | sed 's|https://||')
  # ^|^ makes | the delimiter so JSON commas/colons in values are safe.
  _PATCH_VARS="NODE_ENV=production|NODE_APP_INSTANCE=cloudrun|GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}|NODE_CONFIG={\"app\":{\"url\":{\"hostname\":\"${HOSTNAME}\"}}}|GOOGLE_CALLBACK_URL=https://${HOSTNAME}/auth/google/callback|FIREBASE_CLIENT_CONFIG=${FIREBASE_CLIENT_CONFIG}"
  [[ -n "${_LIVE_ADMIN_EMAILS:-}" ]] && _PATCH_VARS="${_PATCH_VARS}|ADMIN_EMAILS=${_LIVE_ADMIN_EMAILS}"
  gcloud run services update "${SERVICE_NAME}" \
    --region="${GOOGLE_CLOUD_REGION}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --update-env-vars "^|^${_PATCH_VARS}" \
    --quiet
fi

# Set up a weekly Firestore backup schedule (idempotent — skips if one exists).
echo "--- Ensuring Firestore backup schedule ---"
_EXISTING_BACKUP=$(gcloud firestore backups schedules list \
  --database='(default)' \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --format='value(name)' 2>/dev/null | head -1)
if [[ -z "${_EXISTING_BACKUP}" ]]; then
  gcloud firestore backups schedules create \
    --database='(default)' \
    --recurrence=weekly \
    --day-of-week=sunday \
    --retention=4w \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --quiet
  echo "    Weekly backup schedule created (4-week retention)"
else
  echo "    Backup schedule already exists — skipping"
fi

# Create a monthly budget alert (idempotent — skips if a budget already exists).
echo "--- Ensuring billing budget alert (${MONTHLY_BUDGET} USD/month) ---"
_BILLING_ACCOUNT=$(gcloud billing projects describe "${GOOGLE_CLOUD_PROJECT}" \
  --format='value(billingAccountName)' 2>/dev/null | sed 's|billingAccounts/||')
if [[ -n "${_BILLING_ACCOUNT}" ]]; then
  _EXISTING_BUDGET=$(gcloud billing budgets list \
    --billing-account="${_BILLING_ACCOUNT}" \
    --filter="displayName=trinket-${GOOGLE_CLOUD_PROJECT}" \
    --format='value(name)' 2>/dev/null | head -1)
  if [[ -z "${_EXISTING_BUDGET}" ]]; then
    gcloud billing budgets create \
      --billing-account="${_BILLING_ACCOUNT}" \
      --display-name="trinket-${GOOGLE_CLOUD_PROJECT}" \
      --budget-amount="${MONTHLY_BUDGET}USD" \
      --threshold-rule=percent=0.5 \
      --threshold-rule=percent=0.9 \
      --threshold-rule=percent=1.0 \
      --filter-projects="projects/${GOOGLE_CLOUD_PROJECT}" \
      --quiet
    echo "    Budget alert created: email at 50%, 90%, 100% of \$${MONTHLY_BUDGET}/month"
  else
    echo "    Budget alert already exists — skipping"
  fi
else
  echo "    Could not determine billing account — skipping budget alert"
fi

echo ""
echo "=== Deployment complete ==="
echo "URL: ${SERVICE_URL}"
