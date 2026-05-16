#!/usr/bin/env bash
# emulator.sh — start the Firestore emulator for local development.
# Requires: firebase-tools (npm install -g firebase-tools)
#           Java 11+ on PATH

exec firebase emulators:start --only firestore,storage --project "${GOOGLE_CLOUD_PROJECT:-demo-trinket}"
