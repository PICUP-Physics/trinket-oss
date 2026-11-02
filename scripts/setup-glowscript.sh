#!/usr/bin/env bash
# Install the Web VPython runtime (3.2.3) into the running dev container.
#
# Run this after:
#   - changing RSWVPRUNNER_RELEASE / the *_SHA256 pins in the Dockerfile
#   - rebuilding rsWVPRunner locally (a sibling checkout's package/ wins)
#   - the very first `docker compose up` (anonymous volume pre-dates the 3.2.3 curl step)
#
# Alternatively, `docker compose up --build` rebuilds the image and re-initializes
# the components volume from the release — no need to run this script after that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER=trinket-gcr
DEST=/usr/local/node/trinket/public/components/vpython-glowscript/package

# Sibling repo layout: glow-repos/webvpython/rsWVPRunner/  (may not exist everywhere)
LOCAL_PKG="$REPO_ROOT/../webvpython/rsWVPRunner/package"

# Release tag and sha256 pins: the Dockerfile's ARG block is the single source
# of truth, so this script and the image build cannot drift.
arg() {
  sed -n "s/^ARG $1=\(.*\)$/\1/p" "$REPO_ROOT/Dockerfile" | head -1
}
RELEASE=$(arg RSWVPRUNNER_RELEASE)
if [ -z "$RELEASE" ]; then
  echo "Error: could not read RSWVPRUNNER_RELEASE from $REPO_ROOT/Dockerfile" >&2
  exit 1
fi
BASE="https://github.com/vpython/rsWVPRunner/releases/download/$RELEASE"

if ! docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  echo "Error: container '$CONTAINER' is not running."
  echo "Start it first: docker compose up -d"
  exit 1
fi

echo "Installing Web VPython runtime 3.2.3 (release: $RELEASE) into $CONTAINER..."

install_file() {
  local src_name="$1" dest_name="$2" sha_arg="$3"

  if [[ -f "$LOCAL_PKG/$src_name" ]]; then
    echo "  $src_name → $dest_name  (from local rsWVPRunner build)"
    docker cp "$LOCAL_PKG/$src_name" "$CONTAINER:$DEST/$dest_name"
  else
    echo "  $src_name → $dest_name  (from release $RELEASE)"
    local tmp
    tmp=$(mktemp)
    curl -fL --silent -o "$tmp" "$BASE/$src_name"
    echo "$(arg "$sha_arg")  $tmp" | shasum -a 256 -c - >/dev/null
    docker cp "$tmp" "$CONTAINER:$DEST/$dest_name"
    rm -f "$tmp"
  fi
}

install_file glow.3.2.min.js        glow.3.2.3.min.js        GLOW_SHA256
install_file RScompiler.3.2.min.js  RScompiler.3.2.3.min.js  RSCOMPILER_SHA256
install_file RSrun.3.2.min.js       RSrun.3.2.3.min.js       RSRUN_SHA256

echo "Done. Reload your browser to pick up the new runtime."
