// Site-admin identity — portable, no GCP/Datastore (safe for oss/mongo+redis).
//
// The admin-email allowlist (config.auth.adminEmails / env ADMIN_EMAILS) is a SEED, not a
// per-request gate. At login the matching user is stamped with the site 'admin' role
// (see ensureSeedAdminRole), and every gate afterwards checks user.hasRole('admin') only.
// This collapses the old "is it the role OR the email list?" ambiguity to a single concept.
//
// The list still has two inherent jobs that pre-date the user's role:
//   1. signup approval (instructorAuth.isApprovedToSignup) — runs before a user/role exists
//   2. the login stamp below
// Everything else reads the role.
'use strict';
var config = require('config');

function getAdminEmails() {
  if (process.env.ADMIN_EMAILS) {
    try { return JSON.parse(process.env.ADMIN_EMAILS); } catch (e) {}
  }
  return (config.auth && config.auth.adminEmails) || [];
}

function isAdminEmail(email) {
  if (!email) return false;
  var e = String(email).toLowerCase();
  return getAdminEmails().some(function (a) { return String(a).toLowerCase() === e; });
}

// Stamp the site 'admin' role onto a user whose email is in the seed list, if it is absent.
// Idempotent: writes (via user.grant -> findByIdAndUpdate) ONLY when the role is actually added,
// so the common non-admin login path performs no extra write. Returns a promise of the user.
function ensureSeedAdminRole(user) {
  if (!user || !user.email) return Promise.resolve(user);
  if (!isAdminEmail(user.email)) return Promise.resolve(user);
  if (user.hasRole && user.hasRole('admin')) return Promise.resolve(user);
  return Promise.resolve(user.grant('admin', 'site')).then(function () { return user; });
}

module.exports = {
  getAdminEmails: getAdminEmails,
  isAdminEmail: isAdminEmail,
  ensureSeedAdminRole: ensureSeedAdminRole
};
