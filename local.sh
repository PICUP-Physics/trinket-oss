#!/usr/bin/env bash
# local.sh — run trinket-oss locally against the Firestore emulator.
# Assumes the emulator is already running:
#   firebase emulators:start --only firestore --project demo-trinket

set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: local.sh

Run Trinket locally against the Firestore emulator (no Docker).

Requires:
  nvm with the project's Node version installed
  ./emulator.sh running in a separate terminal
EOF
  exit 0
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

nvm use

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-localhost:8080}"
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-demo-trinket}"
export NODE_ENV="${NODE_ENV:-development}"

# Force Firestore backend regardless of what local.yaml says.
# NODE_CONFIG overrides all config files in node-config.
export NODE_CONFIG='{"db":{"backend":"firestore","firestore":{"projectId":"'"${GOOGLE_CLOUD_PROJECT}"'"},"redis":{"enabled":false}}}'

exec node app.js
