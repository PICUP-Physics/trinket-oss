#!/usr/bin/env bash
# dev-docker.sh — build and run trinket-oss in a linux/amd64 Docker container
#                 against the Firestore emulator running on the Mac host.
#
# Prerequisites:
#   ./emulator.sh   (in a separate terminal)
#
# Usage:
#   ./dev-docker.sh           # run (builds image if not present)
#   ./dev-docker.sh --build   # force rebuild image

set -euo pipefail

# Load .env if present (provides GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, etc.)
if [[ -f .env ]]; then
  set -o allexport
  source .env
  set +o allexport
fi

IMAGE="trinket-oss:local"
PORT="${PORT:-3000}"
PROJECT="demo-trinket"
EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-localhost:8080}"
STORAGE_HOST="${STORAGE_EMULATOR_HOST:-http://localhost:9199}"

# Translate localhost → host.docker.internal so the container reaches the Mac emulator
DOCKER_EMULATOR_HOST="${EMULATOR_HOST/localhost/host.docker.internal}"
DOCKER_STORAGE_HOST="${STORAGE_HOST/localhost:9199/host.docker.internal:9199}"

FORCE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --build|-b) FORCE_BUILD=true ;;
  esac
done

# Build if forced or image is missing
if $FORCE_BUILD || ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "Building $IMAGE (--platform linux/amd64)..."
  docker build --platform linux/amd64 -t "$IMAGE" .
fi

# Warn if the emulator doesn't appear to be reachable
if ! curl -sf --connect-timeout 2 "http://${EMULATOR_HOST}" &>/dev/null; then
  echo "WARNING: Firestore emulator not detected at $EMULATOR_HOST"
  echo "         Run ./emulator.sh in another terminal first."
fi

echo "Starting trinket-oss → http://localhost:${PORT}"
echo "  Firestore emulator : ${DOCKER_EMULATOR_HOST}"
echo "  Storage emulator   : ${DOCKER_STORAGE_HOST}"

exec docker run --rm -it --init \
  --platform linux/amd64 \
  --add-host=host.docker.internal:host-gateway \
  -p "${PORT}:3000" \
  -e "SESSION_PASSWORD=${SESSION_PASSWORD:-}" \
  -e "FIRESTORE_EMULATOR_HOST=${DOCKER_EMULATOR_HOST}" \
  -e "STORAGE_EMULATOR_HOST=${DOCKER_STORAGE_HOST}" \
  -e "STORAGE_PUBLIC_HOST=http://localhost:9199" \
  -e "GOOGLE_CLOUD_PROJECT=${PROJECT}" \
  -e "NODE_ENV=development" \
  -e "NODE_CONFIG={\"app\":{\"url\":{\"protocol\":\"http\",\"hostname\":\"localhost\",\"port\":${PORT}},\"auth\":{\"google\":{\"clientID\":\"${GOOGLE_CLIENT_ID:-}\",\"clientSecret\":\"${GOOGLE_CLIENT_SECRET:-}\",\"callbackURL\":\"http://localhost:${PORT}/auth/google/callback\"}}},\"db\":{\"backend\":\"firestore\",\"firestore\":{\"projectId\":\"${PROJECT}\"},\"redis\":{\"enabled\":false}},\"features\":{\"trinkets\":{\"python\":false,\"html\":false,\"glowscript\":true}}}" \
  "$IMAGE" \
  node app.js
