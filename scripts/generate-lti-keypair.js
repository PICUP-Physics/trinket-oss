#!/usr/bin/env node
//
// scripts/generate-lti-keypair.js
//
// Generate the LTI 1.3 Tool RS256 keypair (used to sign Tool JWTs; public key served at
// /lti/jwks). Run ONCE; trinket uses one keypair across all platforms (LTI-SPEC.md §11).
//
// Usage:
//   node scripts/generate-lti-keypair.js
//
// Then:
//   - Local (.env):        copy the LTI_PRIVATE_KEY=... line (base64, single line).
//   - Cloud Run (prod):    store the raw PEM in Secret Manager as `trinket-lti-private-key`
//                          and wire it as env LTI_PRIVATE_KEY in deploy-cloudrun.sh.
//
// The private key is printed to STDOUT; everything else goes to STDERR, so you can capture just
// the PEM with:  node scripts/generate-lti-keypair.js 2>/dev/null > lti-private-key.pem
// (Do NOT commit that file.)
'use strict';

var crypto = require('crypto');

var keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

var publicJwk = crypto.createPublicKey(keys.publicKey).export({ format: 'jwk' });
var canonical = JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n });
var kid       = crypto.createHash('sha256').update(canonical).digest('base64url');
var pemB64    = Buffer.from(keys.privateKey, 'utf8').toString('base64');

console.error('LTI Tool keypair generated.  kid = ' + kid);
console.error('');
console.error('── 1) Local development (.env) ───────────────────────────────────────────');
console.error('Add this single line to .env (base64-wrapped PEM):');
console.error('');
console.error('LTI_PRIVATE_KEY=' + pemB64);
console.error('');
console.error('── 2) Cloud Run (Secret Manager) ─────────────────────────────────────────');
console.error('Store the PEM below as secret `trinket-lti-private-key`, then add it as env');
console.error('LTI_PRIVATE_KEY in deploy-cloudrun.sh (same pattern as SESSION_PASSWORD):');
console.error('');

// Private key PEM → stdout (capture-friendly).
process.stdout.write(keys.privateKey);
