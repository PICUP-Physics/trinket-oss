'use strict';
// Print the log token for one or more email addresses, so an admin can grep the
// server logs for one student. Uses the same key as the app (ferpa.logTokenSecret
// or FERPA_LOG_TOKEN_SECRET; otherwise the session-password fallback, with the
// same warning the app writes). Run it from the repository root:
//   node scripts/log-email-token.js student@school.edu
//   docker compose exec app node scripts/log-email-token.js student@school.edu
// Run it in the app's environment and from the repository root, or the key (and
// so the token) will differ from the logs.
// Notes:
// - With TRINKET_DEPLOY set, config/deploy-dir prints a "[deploy-dir] merged ..."
//   line on stdout before the tokens.
// - On hosts without exec into the app (e.g. Cloud Run), run it from a checkout of
//   the same version, with the same deploy overlay and FERPA_LOG_TOKEN_SECRET set
//   to the production value.
// - Tokens are 8 hex characters, so two addresses at one domain can occasionally
//   share a token: confirm a match by time and user id.

// Arguments are checked first, before config loads, so a bad call prints nothing on
// stdout even when TRINKET_DEPLOY makes config/deploy-dir print its merge line.
var addresses = process.argv.slice(2);

if (!addresses.length) {
  console.error('usage: node scripts/log-email-token.js <bare address> [<bare address> ...]');
  process.exit(2);
}

// Validate every argument before printing anything: a pasted "Jane <a@b.edu>" or
// "mailto:a@b.edu" would hash to a token that never matches the logs, and a
// token for part of the input is worse than none.
addresses.forEach(function(address) {
  if (/[\s<>,;:"]/.test(address) || address.split('@').length !== 2) {
    console.error('log-email-token: "' + address + '" is not a bare email address (e.g. student@school.edu)');
    process.exit(2);
  }
});

// Same guards as app.js: without them node-config 0.4 persists config changes
// (including the deploy overlay merge below) to config/runtime.json.
process.env.NODE_CONFIG_PERSIST_ON_CHANGE  = process.env.NODE_CONFIG_PERSIST_ON_CHANGE  || 'N';
process.env.NODE_CONFIG_DISABLE_FILE_WATCH = process.env.NODE_CONFIG_DISABLE_FILE_WATCH || 'Y';

// Per-deploy overlays (TRINKET_DEPLOY) must be merged before anything reads config.
require('../config/deploy-dir');
var logPrivacy = require('../lib/util/logPrivacy');

if (logPrivacy.keySource() === 'random') {
  console.error('log-email-token: no ferpa.logTokenSecret or session cookie password is configured here, ' +
    'so a token printed now could never match the logs. Run this where the app runs, from the ' +
    'repository root (e.g. docker compose exec app node scripts/log-email-token.js <address>).');
  process.exit(1);
}

addresses.forEach(function(address) {
  console.log(address + ' -> ' + logPrivacy.token(address));
});
