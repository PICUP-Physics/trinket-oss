#!/usr/bin/env bash
# Publish this deploy's static assets to Firebase Hosting's CDN.
#
# WHY THIS EXISTS
# ---------------
# Assets served *through* a Firebase Hosting rewrite inherit
#   vary: accept-encoding, cookie, need-authorization, x-fh-requested-host
# and a cookie-bearing request then bypasses the edge entirely. Since the app
# sets a session cookie on the home page, every real browser carries one, so a
# rewrite-only setup delivers nothing: measured 25/25 asset requests still
# reaching Cloud Run. Uploading the assets makes them STATIC files, which
# Hosting matches before it applies rewrites — same measurement afterwards:
# 25/25 served from the edge, 0 reaching Cloud Run.
#
# The upload is keyed to the deploy's commit, matching the /cache-prefix-<sha>/
# URLs the app emits (see lib/util/assetVersion.js), so each deploy publishes a
# fresh, immutable set and old ones simply stop being requested.
#
# USAGE
#   scripts/deploy-hosting.sh                     # infer commit from the service
#   COMMIT=abc1234 scripts/deploy-hosting.sh      # pin it explicitly
#   ASSET_SRC=/path/to/public scripts/deploy-hosting.sh   # skip image extraction
#
# ENV
#   FIREBASE_PROJECT   (required) Firebase/GCP project id
#   HOSTING_SITE       (required) Hosting site id
#   HOSTING_REWRITES   (required) the site's rewrites as JSON. `firebase deploy
#                      --only hosting` REPLACES the site's config, so whatever
#                      is passed here becomes the site's ONLY rewrites:
#                        front-door site (Hosting in front of the app):
#                          '[{"source":"**","run":{"serviceId":"<service>","region":"us-central1"}}]'
#                        assets-only site (no rewrites, on purpose):
#                          '[]'
#                      Required precisely so an assets upload can never
#                      silently strip the run rewrite off a front-door site.
#   SERVICE_URL        (required unless COMMIT and ASSET_SRC are both set)
#   IMAGE              container image to extract assets from (needs docker)
#   ASSET_SRC          a public/ directory to use instead of extracting
#   COMMIT             deploy commit; else read from ${SERVICE_URL}/version
set -euo pipefail

FIREBASE_PROJECT="${FIREBASE_PROJECT:?set FIREBASE_PROJECT}"
HOSTING_SITE="${HOSTING_SITE:?set HOSTING_SITE}"
HOSTING_REWRITES="${HOSTING_REWRITES:?set HOSTING_REWRITES — [] for an assets-only site, or the run-rewrite JSON for a front-door site. This deploy REPLACES the sites rewrites}"
SERVICE_URL="${SERVICE_URL:-}"
IMAGE="${IMAGE:-}"
ASSET_SRC="${ASSET_SRC:-}"
COMMIT="${COMMIT:-}"

# Small, always-requested tiers. components/ is deliberately NOT wholesale: it
# is ~441 MB of source trees in the image and almost none of it is ever fetched.
ASSET_DIRS="${ASSET_DIRS:-css js img fonts partials}"

# Pages crawled to discover which components/ files this deploy actually
# references. Anything missed simply falls through to the origin and still
# works — uncached, not broken.
CRAWL_PATHS="${CRAWL_PATHS:-/ /embed/python3 /embed/glowscript /embed/pyodide}"

# The glowscript RUNNER's files are referenced from a client-side srcdoc
# template ({{prefix}}components/...), so the page crawl cannot see them —
# and they are precisely the files a cold-start herd sheds (glow.min.js,
# 4.2 MB, lost for 17% of 1000 students in the 2026-08-24 test). Same story
# for ace's lazily-loaded modes/themes (src-min-noconflict). Published
# explicitly. RUNNER_VERSION tracks the versionMap's current
# trinket build (the same pin the Dockerfile provisions).
RUNNER_VERSION="${RUNNER_VERSION:-3.2.3}"
RUNNER_PATHS="${RUNNER_PATHS:-components/vpython-glowscript/package/glow.RUNNER_VERSION.min.js components/vpython-glowscript/package/RSrun.RUNNER_VERSION.min.js components/vpython-glowscript/package/RScompiler.RUNNER_VERSION.min.js components/vpython-glowscript/package/reportScriptError-0.1.js components/vpython-glowscript/lib/jquery components/vpython-glowscript/css components/src-min-noconflict}"
RUNNER_PATHS="${RUNNER_PATHS//RUNNER_VERSION/${RUNNER_VERSION}}"

say() { printf '  %s\n' "$*"; }

# --- 1. which commit are we publishing for? -------------------------------
if [[ -z "${COMMIT}" ]]; then
  [[ -n "${SERVICE_URL}" ]] || { echo "Need COMMIT or SERVICE_URL" >&2; exit 1; }
  COMMIT=$(curl -fsS --max-time 60 "${SERVICE_URL}/version" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"])')
fi
[[ -n "${COMMIT}" && "${COMMIT}" != "unknown" ]] || {
  echo "Refusing to publish: the deploy reports commit '${COMMIT}'." >&2
  echo "Assets would be uploaded under a prefix the app never emits." >&2
  exit 1
}
say "publishing assets for commit ${COMMIT}"

# --- 2. get the BUILT assets ----------------------------------------------
# The checkout is not enough: base.css and components/ are produced at image
# build time, so the host tree has ~96 KB of css where the image has 652 KB.
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

if [[ -n "${ASSET_SRC}" ]]; then
  say "using assets from ${ASSET_SRC}"
  SRC="${ASSET_SRC}"
else
  [[ -n "${IMAGE}" ]] || { echo "Need IMAGE or ASSET_SRC" >&2; exit 1; }
  command -v docker >/dev/null || { echo "docker required to extract ${IMAGE}" >&2; exit 1; }
  say "extracting public/ from ${IMAGE}"
  docker pull -q "${IMAGE}" >/dev/null
  cid=$(docker create "${IMAGE}")
  docker cp "${cid}:/usr/local/node/trinket/public" "${WORK}/public" >/dev/null
  docker rm -f "${cid}" >/dev/null
  SRC="${WORK}/public"
fi

# --- 3. stage under the versioned prefix AND at bare paths ------------------
# Bare paths matter as much as the stamped ones: embed pages reference ~33
# files as plain /js/... and /components/... (no cache-prefix), and every one
# of those otherwise rides the rewrite to the origin on every view. Measured
# 2026-08-24: a 1000-student cold herd shed glow.min.js for 17% of students —
# all on bare-path files. Hosting matches static files BEFORE rewrites, so
# publishing them here moves that whole class of traffic to the edge with no
# app change. Bare paths get a SHORT max-age (they change in place across
# deploys); each hosting deploy also purges Firebase's CDN.
SITE="${WORK}/site"
PREFIX="${SITE}/cache-prefix-${COMMIT}"
mkdir -p "${PREFIX}"

# components/ is published under its own CONTENT hash, not the deploy commit
# (picup #238). It changes a few times a year while the commit changes several
# times a day, so sharing the deploy prefix re-issued ~6.6 MB of URLs per deploy
# whose bytes had not moved. The hash is written into the image by the Dockerfile
# and travels with the extracted public/. Same cache-prefix-* URL SHAPE, so the
# server's prefix-stripping and Hosting's /cache-prefix-*/** immutable header
# rule both apply unchanged — no new routing, no new header rule.
COMPONENTS_TOKEN="${COMMIT}"
if [[ -f "${SRC}/components-hash.txt" ]]; then
  COMPONENTS_TOKEN="$(tr -d '[:space:]' < "${SRC}/components-hash.txt")"
  say "components hash: ${COMPONENTS_TOKEN} (stable across deploys)"
else
  say "no components-hash.txt in the image — components stay on the deploy prefix"
fi
CPREFIX="${SITE}/cache-prefix-${COMPONENTS_TOKEN}"
mkdir -p "${CPREFIX}"
for d in ${ASSET_DIRS}; do
  [[ -d "${SRC}/${d}" ]] && cp -R "${SRC}/${d}" "${PREFIX}/" && cp -R "${SRC}/${d}" "${SITE}/"
done

# The active deploy's overlay, staged ON TOP of the stock assets.
#
# config/deploy-dir.js: "deploys/<name>/public/ static assets ahead of public/
# — same-name shadowing". The app serves the overlay first, so the CDN has to
# hold the same files, in the same precedence. It did not: assets are extracted
# from the built IMAGE and an overlay lives in the deploy folder, never in the
# image. Every overlay-only file was therefore missing from Hosting and rode the
# rewrite to the origin on every view — mandi's brand-overrides.css, 14 KB, on
# every new visitor, while the same check scored a clean 25/25 on uindy purely
# because uindy references no overlay asset.
OVERLAY_ROOT="${OVERLAY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ -z "${OVERLAY_SRC:-}" && -n "${TRINKET_DEPLOY:-}" ]]; then
  _cand="${OVERLAY_ROOT}/deploys/${TRINKET_DEPLOY}/public"
  [[ -d "${_cand}" ]] && OVERLAY_SRC="${_cand}"
fi
if [[ -n "${OVERLAY_SRC:-}" ]]; then
  _ov=0
  for d in ${ASSET_DIRS}; do
    [[ -d "${OVERLAY_SRC}/${d}" ]] || continue
    mkdir -p "${PREFIX}/${d}" "${SITE}/${d}"
    cp -R "${OVERLAY_SRC}/${d}/." "${PREFIX}/${d}/"
    cp -R "${OVERLAY_SRC}/${d}/." "${SITE}/${d}/"
    _ov=$(( _ov + $(find "${OVERLAY_SRC}/${d}" -type f | wc -l) ))
  done
  say "overlay assets published from ${OVERLAY_SRC}: ${_ov}"
elif [[ -n "${TRINKET_DEPLOY:-}" ]]; then
  say "no overlay assets for ${TRINKET_DEPLOY} (deploys/${TRINKET_DEPLOY}/public not found)"
fi

if [[ -n "${SERVICE_URL}" ]]; then
  refs="${WORK}/refs"; : > "${refs}"
  for p in ${CRAWL_PATHS}; do
    curl -fsS --max-time 60 "${SERVICE_URL}${p}" 2>/dev/null \
      | grep -oE '(/cache-prefix-[^"'"'"' ]+|/components/[^"'"'"' ]+)' >> "${refs}" || true
  done
  n=0
  while read -r f; do
    [[ -f "${SRC}/${f}" ]] || continue
    mkdir -p "${CPREFIX}/$(dirname "${f}")" "${SITE}/$(dirname "${f}")"
    cp "${SRC}/${f}" "${CPREFIX}/${f}"
    cp "${SRC}/${f}" "${SITE}/${f}" && n=$((n+1))
  done < <(sed 's|^/cache-prefix-[^/]*/|/|' "${refs}" \
             | grep -oE '^/components/[^"'"'"' ]+' | sed 's|^/||' | sort -u)
  say "components referenced by this deploy: ${n} (published stamped AND bare)"
fi

# Runner files: same dual publication (stamped + bare) as everything else.
rn=0
for rel in ${RUNNER_PATHS}; do
  if [[ -d "${SRC}/${rel}" ]]; then
    mkdir -p "${CPREFIX}/$(dirname "${rel}")" "${SITE}/$(dirname "${rel}")"
    cp -R "${SRC}/${rel}" "${CPREFIX}/$(dirname "${rel}")/"
    cp -R "${SRC}/${rel}" "${SITE}/$(dirname "${rel}")/"
    rn=$((rn+1))
  elif [[ -f "${SRC}/${rel}" ]]; then
    mkdir -p "${CPREFIX}/$(dirname "${rel}")" "${SITE}/$(dirname "${rel}")"
    cp "${SRC}/${rel}" "${CPREFIX}/${rel}"
    cp "${SRC}/${rel}" "${SITE}/${rel}"
    rn=$((rn+1))
  else
    say "WARNING: runner path missing from image: ${rel}"
  fi
done
say "runner files/dirs published: ${rn} (version ${RUNNER_VERSION})"

say "staged $(find "${SITE}" -type f | wc -l | tr -d ' ') files, $(du -sh "${SITE}" | cut -f1)"

# --- 4. hosting config ----------------------------------------------------
# Static files win over rewrites, so the versioned assets never become rewrite
# responses. Everything else falls through to the app.
# Firebase applies its own max-age=3600 to uploaded files, overriding whatever
# the app would have sent — so the immutable header is restated here.
# ⚠️ Header sources also match REWRITE responses: a negated glob
# (!/cache-prefix-*/**) silently replaced the app's no-store on DYNAMIC pages
# (observed live). Static dirs are enumerated instead — never use a negation
# here.
cat > "${WORK}/firebase.json" <<JSON
{
  "hosting": {
    "site": "${HOSTING_SITE}",
    "public": "site",
    "ignore": ["**/.*"],
    "headers": [
      { "source": "/cache-prefix-*/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
      { "source": "/js/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] },
      { "source": "/css/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] },
      { "source": "/img/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] },
      { "source": "/fonts/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] },
      { "source": "/partials/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] },
      { "source": "/components/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] }
    ],
    "rewrites": ${HOSTING_REWRITES}
  }
}
JSON

# A staging escape hatch: build the tree and the config, then stop. Lets you
# inspect exactly what a publish WOULD upload, and lets the test suite exercise
# this script without a Firebase project.
if [[ -n "${STAGE_ONLY:-}" ]]; then
  _dest="${STAGE_OUT:-${PWD}/hosting-stage}"
  mkdir -p "${_dest}"
  rm -rf "${_dest}/site"
  cp -R "${SITE}" "${_dest}/site"
  cp "${WORK}/firebase.json" "${_dest}/firebase.json"
  say "STAGE_ONLY: staged tree written to ${_dest} — nothing deployed"
  exit 0
fi

say "deploying to ${HOSTING_SITE} (${FIREBASE_PROJECT})"
( cd "${WORK}" && firebase deploy --only hosting --project "${FIREBASE_PROJECT}" )

if [[ -n "${SERVICE_URL}" ]]; then
  say "verify:  curl -sSI -H 'Cookie: x=1' <host>/cache-prefix-${COMMIT}/css/base.css"
  say "         expect 'x-cache: HIT' on the second request and NO 'cookie' in vary"
fi
