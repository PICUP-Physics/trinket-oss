// gcr instructor-authority: consult the instructormi allowlist (Datastore) via instructorAuth.
// Loaded ONLY when config.lti.instructorAuthority === 'instructormi'; carries the @google-cloud
// /datastore dependency that must never reach oss. Role-independent (trusts trinket's own list).
'use strict';
var instructorAuth = require('./instructorAuth');

function resolveInstructor(ctx) {
  var email = (ctx && ctx.email || '').toLowerCase();
  if (email === '') return Promise.resolve(false);
  if (instructorAuth.isAdminEmail(email)) return Promise.resolve(true);
  return Promise.resolve(instructorAuth.isApprovedInstructor(email))
    .catch(function () { return false; });   // fail closed
}

function getInstructorRecord(email) {
  return Promise.resolve(instructorAuth.getInstructorRecord(email)).catch(function () { return null; });
}

module.exports = { resolveInstructor: resolveInstructor, getInstructorRecord: getInstructorRecord };
