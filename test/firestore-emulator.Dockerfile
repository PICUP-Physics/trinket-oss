# Test image for the firestore-profile suite runs:
#   node:20 (matches Cloud Run) + a JRE + the standalone Firestore emulator jar
#   + firebase-tools (for the AUTH emulator).
# Build (once; from repo root):
#   docker build --platform linux/amd64 -t trinket-test-firestore -f test/firestore-emulator.Dockerfile .
#
# FS profile (firestore backend, local-auth logins — fast, jar only):
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD":/app -v <deps-volume>:/app/node_modules -w /app \
#     trinket-test-firestore bash -lc '
#       java -jar /emulator/firestore.jar --host 127.0.0.1 --port 8089 &
#       until curl -s 127.0.0.1:8089 >/dev/null; do sleep 0.5; done
#       TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 \
#         npx vitest run --fileParallelism=false'
#
# Firebase-auth profile (the GCP all-or-none shape: firestore + Firebase Auth;
# logins mint emulator ID tokens through POST /api/auth/session). Uses
# firebase.json (auth 9099, firestore 8080). XDG_CACHE_HOME persists
# firebase-tools' emulator download in the deps volume:
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD":/app -v <deps-volume>:/app/node_modules -w /app \
#     -e XDG_CACHE_HOME=/app/node_modules/.firebase-cache \
#     trinket-test-firestore bash -lc '
#       firebase emulators:start --only auth,firestore --project demo-trinket &
#       until curl -s 127.0.0.1:9099 >/dev/null && curl -s 127.0.0.1:8080 >/dev/null; do sleep 1; done
#       TEST_DB_BACKEND=firestore TEST_AUTH_PROVIDER=firebase \
#       FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
#       GOOGLE_CLOUD_PROJECT=demo-trinket \
#         npx vitest run --fileParallelism=false'
FROM node:20-bullseye
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-11-jre-headless \
  && rm -rf /var/lib/apt/lists/*
ADD https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar /emulator/firestore.jar
# firebase-tools for the AUTH emulator (no standalone jar exists — the auth
# emulator is implemented inside firebase-tools). The firestore jar above
# stays for the fast FS-only profile; the firebase-auth profile runs both
# emulators via `firebase emulators:start` against the repo's firebase.json.
RUN npm install -g firebase-tools@13
