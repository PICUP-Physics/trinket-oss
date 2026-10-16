'use strict';
// Print the log token for one or more email addresses, so an admin can grep the
// server logs for one student. Uses the same key as the app (ferpa.logTokenSecret
// or FERPA_LOG_TOKEN_SECRET; otherwise the session-password fallback, with the
// same warning the app writes). Run it from the repository root:
//   node scripts/log-email-token.js student@school.edu
//   docker compose exec trinket node scripts/log-email-token.js student@school.edu

// Per-deploy overlays (TRINKET_DEPLOY) must be merged before anything reads config.
require('../config/deploy-dir');
var logPrivacy = require('../lib/util/logPrivacy');

var addresses = process.argv.slice(2);

if (!addresses.length) {
  console.error('usage: node scripts/log-email-token.js <address> [<address> ...]');
  process.exit(2);
}

addresses.forEach(function(address) {
  console.log(address + ' -> ' + logPrivacy.token(address));
});
