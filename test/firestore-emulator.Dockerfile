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
# Java comes from the Temurin image rather than apt: bullseye is EOL, so
# `apt-get install openjdk-11-jre-headless` now 404s on the mirrors. The base
# must STAY bullseye — the harness boots mongodb-memory-server even on the
# firestore profile, and its cached mongod links libcrypto.so.1.1, which
# bookworm (OpenSSL 3) does not ship.
FROM eclipse-temurin:17-jre AS jre
FROM node:20-bullseye
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
# ...and a symlink on the default PATH as well. The documented run command below
# uses `bash -lc`, and a login shell sources /etc/profile, which REPLACES the
# PATH that ENV just set — so `java` is not found and the wait-for-emulator loop
# spins forever instead of failing. /usr/local/bin survives that reset.
RUN ln -sf /opt/java/openjdk/bin/java /usr/local/bin/java
ADD https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar /emulator/firestore.jar
# firebase-tools for the AUTH emulator (no standalone jar exists — the auth
# emulator is implemented inside firebase-tools). The firestore jar above
# stays for the fast FS-only profile; the firebase-auth profile runs both
# emulators via `firebase emulators:start` against the repo's firebase.json.
RUN npm install -g firebase-tools@13
