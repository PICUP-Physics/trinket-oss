#!/usr/bin/env bash
# Install the Web VPython runtime (3.2.3) into the running dev container.
#
# Run this after:
#   - rebuilding rsWVPRunner and running do_build.sh (deploys to GCS)
#   - the very first `docker compose up` (anonymous volume pre-dates the 3.2.3 curl step)
#
# Alternatively, `docker compose up --build` rebuilds the image and re-initializes
# the components volume from GCS — no need to run this script after that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER=trinket-gcr
DEST=/usr/local/node/trinket/public/components/vpython-glowscript/package

# Sibling repo layout: glow-repos/webvpython/rsWVPRunner/  (may not exist everywhere)
LOCAL_PKG="$REPO_ROOT/../webvpython/rsWVPRunner/package"

# Cache-buster / GCS query param from the Dockerfile
BUILD_TAG=$(grep 'ARG GLOWSCRIPT_PACKAGE_BUILD=' "$REPO_ROOT/Dockerfile" | cut -d= -f2)

if ! docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  echo "Error: container '$CONTAINER' is not running."
  echo "Start it first: docker compose up -d"
  exit 1
fi

echo "Installing Web VPython runtime 3.2.3 (build: $BUILD_TAG) into $CONTAINER..."

install_file() {
  local src_name="$1" dest_name="$2"

  if [[ -f "$LOCAL_PKG/$src_name" ]]; then
    echo "  $src_name → $dest_name  (from local rsWVPRunner build)"
    docker cp "$LOCAL_PKG/$src_name" "$CONTAINER:$DEST/$dest_name"
  else
    echo "  $src_name → $dest_name  (from GCS, build=$BUILD_TAG)"
    local tmp
    tmp=$(mktemp)
    curl -fL --silent -o "$tmp" \
      "https://storage.googleapis.com/rswvprunner/package/$src_name?build=$BUILD_TAG"
    docker cp "$tmp" "$CONTAINER:$DEST/$dest_name"
    rm -f "$tmp"
  fi
}

install_file glow.3.2.min.js        glow.3.2.3.min.js
install_file RScompiler.3.2.min.js  RScompiler.3.2.3.min.js
install_file RSrun.3.2.min.js       RSrun.3.2.3.min.js

echo "Done. Reload your browser to pick up the new runtime."
