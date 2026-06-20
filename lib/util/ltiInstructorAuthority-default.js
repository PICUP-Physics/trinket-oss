// Default (oss/upstream) instructor-authority: trust the platform. No GCP / Datastore dependency.
// If LTI_INSTRUCTOR_EMAILS (JSON array of lowercased emails) is set, gate on that list instead.
'use strict';

function envList() {
  if (!process.env.LTI_INSTRUCTOR_EMAILS) return null;
  try {
    var arr = JSON.parse(process.env.LTI_INSTRUCTOR_EMAILS);
    return Array.isArray(arr) ? arr.map(function (e) { return String(e).toLowerCase(); }) : null;
  } catch (e) { return null; }
}

function resolveInstructor(ctx) {
  var email = (ctx && ctx.email || '').toLowerCase();
  var list  = envList();
  if (list) return Promise.resolve(email !== '' && list.indexOf(email) >= 0);
  return Promise.resolve(!!(ctx && ctx.lmsTeacher));
}

module.exports = { resolveInstructor: resolveInstructor };
