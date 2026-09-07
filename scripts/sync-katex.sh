#!/usr/bin/env bash
# Fetch the vendored KaTeX assets (katex.min.js, katex.min.css, fonts/*.woff2)
# from the PINNED upstream GitHub release into trinket's served components,
# for local dev. The Dockerfile does the same fetch for images — its
# "KaTeX, vendored" ARG block (KATEX_VERSION / KATEX_SHA256) is the single
# source of truth for the release tag and sha256; this script parses it so
# the two fetch paths can never drift.
#
# public/components is gitignored (and gcloudignored): these files are never
# committed — the release asset, pinned by sha256, IS the artifact.
#
# Only .woff2 fonts are kept: katex.min.css lists woff2 FIRST in every
# @font-face src, so modern browsers never request the .woff/.ttf fallbacks,
# and dropping them saves disk space with no behavior change.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/components/katex"
DOCKERFILE="$ROOT/Dockerfile"

arg() {
  sed -n "s/^ARG $1=\(.*\)$/\1/p" "$DOCKERFILE" | head -1
}
KATEX_VERSION=$(arg KATEX_VERSION)
KATEX_SHA256=$(arg KATEX_SHA256)
if [ -z "$KATEX_VERSION" ] || [ -z "$KATEX_SHA256" ]; then
  echo "FAILED: could not read KATEX_VERSION / KATEX_SHA256 ARGs from $DOCKERFILE" >&2
  exit 1
fi

URL="https://github.com/KaTeX/KaTeX/releases/download/v${KATEX_VERSION}/katex.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching KaTeX v$KATEX_VERSION into $DEST"
curl -fL --silent --show-error -o "$TMP/katex.tar.gz" "$URL"

# sha256sum is the coreutils tool on Linux; shasum is what macOS ships. This
# script is chained into `npm run setup-vendor`, so it has to verify on both.
if command -v sha256sum >/dev/null 2>&1; then
  echo "$KATEX_SHA256  $TMP/katex.tar.gz" | sha256sum -c -
else
  echo "$KATEX_SHA256  $TMP/katex.tar.gz" | shasum -a 256 -c -
fi

mkdir -p "$DEST/fonts"
tar xzf "$TMP/katex.tar.gz" -C "$TMP" \
    katex/katex.min.js katex/katex.min.css katex/fonts
cp "$TMP/katex/katex.min.js" "$TMP/katex/katex.min.css" "$DEST/"
cp "$TMP"/katex/fonts/*.woff2 "$DEST/fonts/"

test -s "$DEST/katex.min.js" && test -s "$DEST/katex.min.css"
test "$(ls -1 "$DEST/fonts"/*.woff2 2>/dev/null | wc -l)" -gt 0

echo "OK: katex.min.js + katex.min.css + fonts/*.woff2 pinned at v$KATEX_VERSION"
