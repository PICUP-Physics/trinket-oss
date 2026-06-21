var Datastore = require('@google-cloud/datastore').Datastore;
var path      = require('path');
var fs        = require('fs');

var dsOptions = { projectId: 'instructormi' };
var instructorAuthEnabled = false;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  dsOptions.credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  instructorAuthEnabled = true;
} else {
  var keyPath = path.join(process.cwd(), 'config/firebase-service-account.json');
  if (fs.existsSync(keyPath)) {
    dsOptions.keyFilename = keyPath;
    instructorAuthEnabled = true;
  } else if (process.env.K_SERVICE) {
    // Running on Cloud Run — Application Default Credentials available
    instructorAuthEnabled = true;
  }
}

if (!instructorAuthEnabled) {
  console.warn('[instructorAuth] No credentials found — cross-project instructor check disabled. Only admins and course-invited users can sign up.');
}

var instructorDs = instructorAuthEnabled ? new Datastore(dsOptions) : null;

// Simple in-memory cache — avoids repeated cross-project Datastore reads
var cache    = {};
var CACHE_MS = 5 * 60 * 1000; // 5 minutes

// Test seam: inject a fake Datastore client (and clear the cache). Not used in production.
function _setDatastore(ds) {
  instructorDs = ds;
  instructorAuthEnabled = !!ds;
  cache = {};
}

async function isApprovedInstructor(email) {
  if (!instructorAuthEnabled) return false;

  var key = email.toLowerCase();

  if (cache[key] && (Date.now() - cache[key].ts) < CACHE_MS) {
    return cache[key].value;
  }

  var results;
  try {
    // Datastore doesn't support OR queries — run both email fields in parallel. Only an
    // authorized record counts: pending (authorized:false) and rejected requesters must NOT pass
    // (matches how the instructormi app itself gates access). Two equality filters use Datastore's
    // zigzag merge, so no composite index is required.
    results = await Promise.all([
      instructorDs.runQuery(
        instructorDs.createQuery('Instructor')
          .filter('emailOfficial', '=', key)
          .filter('authorized', '=', true)
          .limit(1)
      ),
      instructorDs.runQuery(
        instructorDs.createQuery('Instructor')
          .filter('emailSignin', '=', key)
          .filter('authorized', '=', true)
          .limit(1)
      )
    ]);
  } catch (err) {
    console.error('instructorAuth: Datastore query failed for', key, err.message);
    return false;
  }

  var found = results[0][0].length > 0 || results[1][0].length > 0;
  cache[key] = { value: found, ts: Date.now() };
  return found;
}

// The admin-email allowlist lives in the portable siteAdmin module (no Datastore dep). Re-exported
// below for back-compat with existing callers (instructorAuth.isAdminEmail / ltiInstructorAuthority).
var siteAdmin    = require('./siteAdmin');
var isAdminEmail = siteAdmin.isAdminEmail;

// Returns { approved: bool, isInstructor: bool }
async function isApprovedToSignup(email) {
  if (isAdminEmail(email)) return { approved: true, isInstructor: false };

  var instructor = await isApprovedInstructor(email);
  if (instructor) return { approved: true, isInstructor: true };

  // Check if email has a pending invitation to any course
  // (CourseInvitation is the existing system instructors use to add students)
  var invitation = await CourseInvitation.findOne({ email: email.toLowerCase(), status: { $in: ['pending', 'sent'] } });
  if (invitation) return { approved: true, isInstructor: false };

  return { approved: false, isInstructor: false };
}

module.exports = { isApprovedInstructor, isAdminEmail, isApprovedToSignup, _setDatastore };
