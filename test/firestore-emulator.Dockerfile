# Test image for the firestore-profile suite run:
#   node:20 (matches Cloud Run) + a JRE + the standalone Firestore emulator jar.
# Build (once; from repo root):
#   docker build --platform linux/amd64 -t trinket-test-firestore -f test/firestore-emulator.Dockerfile .
# Run the suite (named volume holds linux node_modules, see docs):
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD":/app -v <deps-volume>:/app/node_modules -w /app \
#     trinket-test-firestore bash -lc '
#       java -jar /emulator/firestore.jar --host 127.0.0.1 --port 8089 &
#       until curl -s 127.0.0.1:8089 >/dev/null; do sleep 0.5; done
#       TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 \
#         npx vitest run --fileParallelism=false'
FROM node:20-bullseye
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-11-jre-headless \
  && rm -rf /var/lib/apt/lists/*
ADD https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar /emulator/firestore.jar
