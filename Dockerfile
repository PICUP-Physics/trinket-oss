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
RUN npm install --legacy-peer-deps

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
    base="https://storage.googleapis.com/rswvprunner/package"; \
    dir="public/components/vpython-glowscript/package"; \
    curl -fL --silent -o "$dir/glow.3.2.3.min.js"       "$base/glow.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    curl -fL --silent -o "$dir/RScompiler.3.2.3.min.js" "$base/RScompiler.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    curl -fL --silent -o "$dir/RSrun.3.2.3.min.js"      "$base/RSrun.3.2.min.js?build=${GLOWSCRIPT_PACKAGE_BUILD}"; \
    echo "${GLOW_SHA256}  $dir/glow.3.2.3.min.js"             | sha256sum -c -; \
    echo "${RSCOMPILER_SHA256}  $dir/RScompiler.3.2.3.min.js" | sha256sum -c -; \
    echo "${RSRUN_SHA256}  $dir/RSrun.3.2.3.min.js"           | sha256sum -c -

# Copy source last so code changes don't bust the layers above
COPY --chown=trinket:trinket . .

# Generate CSS assets served from public/css
RUN npm run build:css

ARG COMMIT_ID
ARG NODE_ENV
ENV NODE_ENV=$NODE_ENV

EXPOSE 3000

CMD ["pm2-docker", "start", "app.js"]
