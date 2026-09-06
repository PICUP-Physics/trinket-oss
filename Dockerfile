FROM node:20-bullseye

SHELL ["/bin/bash", "-c"]

# Install build dependencies
RUN apt-get update \
    && apt-get install -y python3 build-essential \
    && apt-get -y autoclean

# Install global tools
RUN npm install -g pm2@5

RUN groupadd -r trinket && \
    useradd -r -g trinket -m -c "trinket user" trinket

RUN mkdir -p /usr/local/node/trinket && chown trinket:trinket /usr/local/node/trinket

USER trinket

WORKDIR /usr/local/node/trinket

# Install dependencies first — cached unless package.json changes
COPY --chown=trinket:trinket package.json package-lock.json ./
# `ci`, not `install`: it installs exactly the tree package-lock.json records,
# so two builds of the same commit produce the same dependencies. That matters
# more now that production runs the image's node_modules rather than a volume
# someone once populated. --legacy-peer-deps is carried over from the previous
# install step; dropping it needs the peer conflicts resolved first.
RUN npm ci --legacy-peer-deps

# Download frontend components — cached unless the release URL changes
RUN curl -L --silent -o ./public-components.tgz \
    https://github.com/trinketapp/trinket-oss/releases/download/v1.1.0/public-components.tgz \
    && tar xzf public-components.tgz \
    && rm public-components.tgz

# Add ACE editor files missing from the components tarball (needed by course editor)
RUN curl -L --silent -o public/components/src-min-noconflict/theme-github.js \
    https://cdnjs.cloudflare.com/ajax/libs/ace/1.2.6/theme-github.min.js \
    && curl -L --silent -o public/components/src-min-noconflict/mode-markdown.js \
    https://cdnjs.cloudflare.com/ajax/libs/ace/1.2.6/mode-markdown.min.js

# Web VPython runtime from the rsWVPRunner build (gs://rswvprunner), pinned as 3.2.3
# in the versionMap (lib/views/embed/glowscript-config.html). The stock 3.2.2 build
# from the tarball stays in place as a fallback. Bump GLOWSCRIPT_PACKAGE_BUILD after
# redeploying rsWVPRunner: it busts both this layer's cache and (as a query param)
# the GCS edge cache, which can otherwise serve hour-old copies.
#
# Each file is pinned to its rsWVPRunner build by sha256: if upstream republishes a
# changed runtime, the sha256sum -c check fails the build instead of silently shipping
# it. After an *intended* rsWVPRunner glow change: redeploy rsWVPRunner, then bump
# GLOWSCRIPT_PACKAGE_BUILD and update the *_SHA256 values below. Recompute via:
#   curl -fsSL "https://storage.googleapis.com/rswvprunner/package/<file>.3.2.min.js" | sha256sum
ARG GLOWSCRIPT_PACKAGE_BUILD=2026-06-16b
ARG GLOW_SHA256=1587799056b9d5aa5a854ec653653e0c0b6c11ab708a9783e3bffc126104f5ca
ARG RSCOMPILER_SHA256=ada7775620cdea6472de0e7bd4175e126a3f232c74bf6392dbf238350c14c588
ARG RSRUN_SHA256=2735844b615f87b4147e9cb2b90bf8a7a15da208fc8876eae469fc98861e429d
RUN set -eu; \
    RETRY="--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors"; \
    base="https://storage.googleapis.com/rswvprunner/package"; \
    dir="public/components/vpython-glowscript/package"; \
    curl -fL --silent $RETRY -o "$dir/glow.3.2.3.min.js"       "$base/glow.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    curl -fL --silent $RETRY -o "$dir/RScompiler.3.2.3.min.js" "$base/RScompiler.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    curl -fL --silent $RETRY -o "$dir/RSrun.3.2.3.min.js"      "$base/RSrun.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    echo "${GLOW_SHA256}  $dir/glow.3.2.3.min.js"             | sha256sum -c -; \
    echo "${RSCOMPILER_SHA256}  $dir/RScompiler.3.2.3.min.js" | sha256sum -c -; \
    echo "${RSRUN_SHA256}  $dir/RSrun.3.2.3.min.js"           | sha256sum -c -

# vpython-jupyter worker assets (workerVPython opt-in): the pure-Python wheel
# the worker micropip-installs, and the glowcomm_host.js front-end factory.
# Fetched from a pinned upstream GitHub release, sha256-checked — the same
# pattern as the rsWVPRunner files above. public/components is gitignored AND
# gcloudignored, so a checked-in copy would never reach a Cloud Build context;
# the release asset is the artifact. Local dev: scripts/sync-vpython-worker.sh
# does this same fetch, parsing these ARGs so the pins cannot drift.
# The wheel filename must match VPYTHON_WHEEL_NAME in public/js/embed/pyodide.js.
ARG VPYTHON_WHEEL_RELEASE=v7.6.6.dev0
ARG VPYTHON_WHEEL_SHA256=1b319fd882f409fc32445bf464ff7787cac6571f3bd6accb2ee37d217a9c5050
ARG GLOWCOMM_HOST_SHA256=6cf90f51deec78c91b6a6c768b0c4389631218ca31dbdc9b06c6d977d0fced32
RUN set -eu; \
    RETRY="--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors"; \
    base="https://github.com/vpython/vpython-jupyter/releases/download/${VPYTHON_WHEEL_RELEASE}"; \
    dir="public/components/vpython-worker"; \
    mkdir -p "$dir"; \
    wheel="vpython-${VPYTHON_WHEEL_RELEASE#v}-py3-none-any.whl"; \
    curl -fL --silent $RETRY -o "$dir/$wheel"            "$base/$wheel"; \
    curl -fL --silent $RETRY -o "$dir/glowcomm_host.js"  "$base/glowcomm_host.js"; \
    echo "${VPYTHON_WHEEL_SHA256}  $dir/$wheel"            | sha256sum -c -; \
    echo "${GLOWCOMM_HOST_SHA256}  $dir/glowcomm_host.js"  | sha256sum -c -

# KaTeX, vendored for the typeset math output feature (features.mathOutput).
# Same pattern as the assets above: a pinned upstream GitHub release asset,
# sha256-checked, so a republished tarball fails the build instead of shipping
# silently. public/components is gitignored AND gcloudignored — the release
# asset IS the artifact. Local dev: scripts/sync-katex.sh does this same fetch,
# parsing these ARGs so the pins cannot drift.
#
# Vendored rather than CDN-loaded for three reasons (see the design spec):
# a real CSP is served on /embed/python3 by every deploy; the snapshot
# rasterizer (public/js/util/html-to-image.js) can only embed @font-face fonts
# from same-origin stylesheets; and cdnOrigins is meant to empty out.
#
# Only .woff2 fonts are kept: katex.min.css lists woff2 FIRST in every
# @font-face src, so modern browsers never request the .woff/.ttf fallbacks
# and dropping them saves ~1 MB on disk. The CSS references fonts by relative
# path (fonts/KaTeX_Main-Regular.woff2) and contains no absolute URLs, so the
# whole set resolves under whatever /cache-prefix-<commit>/ the page emits.
# Recompute the pin after an intended bump via:
#   curl -fsSL "https://github.com/KaTeX/KaTeX/releases/download/v<ver>/katex.tar.gz" | sha256sum
ARG KATEX_VERSION=0.18.5
ARG KATEX_SHA256=a4122a3f8879fd2b9db5de6a8f19113b2287ab305ee20ed9ca60bd9caf8ae369
RUN set -eu; \
    RETRY="--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors"; \
    url="https://github.com/KaTeX/KaTeX/releases/download/v${KATEX_VERSION}/katex.tar.gz"; \
    dir="public/components/katex"; \
    tmp="$(mktemp -d)"; \
    curl -fL --silent $RETRY -o "$tmp/katex.tar.gz" "$url"; \
    echo "${KATEX_SHA256}  $tmp/katex.tar.gz" | sha256sum -c -; \
    mkdir -p "$dir"; \
    tar xzf "$tmp/katex.tar.gz" -C "$tmp" \
        katex/katex.min.js katex/katex.min.css katex/fonts; \
    cp "$tmp/katex/katex.min.js" "$tmp/katex/katex.min.css" "$dir/"; \
    mkdir -p "$dir/fonts"; \
    cp "$tmp"/katex/fonts/*.woff2 "$dir/fonts/"; \
    rm -rf "$tmp"; \
    test -s "$dir/katex.min.js" && test -s "$dir/katex.min.css"; \
    test "$(ls -1 "$dir/fonts" | wc -l)" -gt 0

# Copy source last so code changes don't bust the layers above
COPY --chown=trinket:trinket . .

# Generate CSS assets served from public/css
RUN npm run build:css

RUN npm run build

# Build identity, surfaced by GET /version. COMMIT_ID was declared here for a
# long time but never promoted to ENV and never passed by any build, so it
# stamped nothing and there was no way to tell which build a deploy was running.
ARG COMMIT_ID
ARG GIT_BRANCH
ARG BUILD_TIME
ENV COMMIT_ID=$COMMIT_ID \
    GIT_BRANCH=$GIT_BRANCH \
    BUILD_TIME=$BUILD_TIME

ARG NODE_ENV
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000

CMD ["pm2-docker", "start", "app.js"]
