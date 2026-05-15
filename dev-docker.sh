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

IMAGE="trinket-oss:local"
PORT="${PORT:-3000}"
PROJECT="${GOOGLE_CLOUD_PROJECT:-demo-trinket}"
EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-localhost:8080}"

# Translate localhost → host.docker.internal so the container reaches the Mac emulator
DOCKER_EMULATOR_HOST="${EMULATOR_HOST/localhost/host.docker.internal}"

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

exec docker run --rm -it --init \
  --platform linux/amd64 \
  --add-host=host.docker.internal:host-gateway \
  -p "${PORT}:3000" \
  -e "FIRESTORE_EMULATOR_HOST=${DOCKER_EMULATOR_HOST}" \
  -e "GOOGLE_CLOUD_PROJECT=${PROJECT}" \
  -e "NODE_ENV=development" \
  -e "NODE_CONFIG={\"app\":{\"url\":{\"protocol\":\"http\",\"hostname\":\"localhost\",\"port\":${PORT}}},\"db\":{\"backend\":\"firestore\",\"firestore\":{\"projectId\":\"${PROJECT}\"},\"redis\":{\"enabled\":false}},\"features\":{\"trinkets\":{\"python\":true,\"html\":true,\"glowscript\":true}}}" \
  "$IMAGE" \
  node app.js
