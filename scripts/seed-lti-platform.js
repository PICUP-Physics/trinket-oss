#!/usr/bin/env node
//
// scripts/seed-lti-platform.js
//
// Register (upsert) an LTI 1.3 platform — one record per LMS instance (LTI-SPEC.md §10).
// Matches on (issuer, clientId); updates fields and merges the deployment id if it already
// exists, otherwise creates a new record.
//
// Usage (local emulator):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-trinket \
//   NODE_ENV=development \
//   node scripts/seed-lti-platform.js \
//     --issuer https://canvas.instructure.com \
//     --client-id 10000000000123 \
//     --auth-login-url https://sso.canvaslms.com/api/lti/authorize_redirect \
//     --jwks-url https://sso.canvaslms.com/api/lti/security/jwks \
//     --auth-token-url https://sso.canvaslms.com/login/oauth2/token \
//     --deployment-id 1:abcd... \
//     --name "UIndy Canvas"
//
// Usage (prod): set GOOGLE_CLOUD_PROJECT / FIRESTORE_PROJECT_ID, NODE_ENV=production,
// NODE_APP_INSTANCE=cloudrun (do NOT source .env first).
'use strict';

var projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

var LtiPlatform = global.LtiPlatform = require('../lib/models/ltiPlatform');

// ── tiny --flag value parser ─────────────────────────────────────────────────
function arg(name) {
  var i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

var fields = {
  issuer       : arg('issuer'),
  clientId     : arg('client-id'),
  authLoginUrl : arg('auth-login-url'),
  authTokenUrl : arg('auth-token-url'),
  jwksUrl      : arg('jwks-url'),
  name         : arg('name')
};
var deploymentId = arg('deployment-id');

var required = ['issuer', 'clientId', 'authLoginUrl', 'jwksUrl'];
var missing = required.filter(function(k) { return !fields[k]; });
if (missing.length) {
  console.error('Missing required flag(s): ' + missing.map(function(k){
    return '--' + k.replace(/([A-Z])/g, '-$1').toLowerCase();
  }).join(', '));
  console.error('See the header of this script for usage.');
  process.exit(1);
}

LtiPlatform.findByIssuer(fields.issuer, fields.clientId, function(err, existing) {
  if (err) { console.error('Lookup failed:', err.message); process.exit(1); }

  var platform = existing || new LtiPlatform({ issuer: fields.issuer, clientId: fields.clientId });
  ['authLoginUrl', 'authTokenUrl', 'jwksUrl', 'name'].forEach(function(k) {
    if (fields[k] !== undefined) platform[k] = fields[k];
  });
  if (deploymentId) {
    var ids = platform.deploymentIds || [];
    if (ids.indexOf(deploymentId) < 0) ids.push(deploymentId);
    platform.deploymentIds = ids;
  }

  platform.save(function(saveErr, doc) {
    if (saveErr) { console.error('Save failed:', saveErr.message); process.exit(1); }
    console.log((existing ? 'Updated' : 'Created') + ' platform ' + (doc.id || '') +
      ' — issuer=' + fields.issuer + ' clientId=' + fields.clientId +
      ' deployments=[' + (doc.deploymentIds || []).join(', ') + ']');
    process.exit(0);
  });
});
