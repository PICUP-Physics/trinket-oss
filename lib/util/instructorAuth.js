var Datastore = require('@google-cloud/datastore').Datastore;
var config    = require('config');
var path      = require('path');
var fs        = require('fs');

var dsOptions = { projectId: 'instructormi' };
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  dsOptions.credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  var keyPath = path.join(process.cwd(), 'config/firebase-service-account.json');
  if (fs.existsSync(keyPath)) dsOptions.keyFilename = keyPath;
  // else: Cloud Run ADC
}
var instructorDs = new Datastore(dsOptions);

// Simple in-memory cache — avoids repeated cross-project Datastore reads
var cache    = {};
var CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function isApprovedInstructor(email) {
  var key = email.toLowerCase();

  if (cache[key] && (Date.now() - cache[key].ts) < CACHE_MS) {
    return cache[key].value;
  }

  var results;
  try {
    // Datastore doesn't support OR queries — run both email fields in parallel
    results = await Promise.all([
      instructorDs.runQuery(
        instructorDs.createQuery('Instructor')
          .filter('emailOfficial', '=', key)
          .limit(1)
      ),
      instructorDs.runQuery(
        instructorDs.createQuery('Instructor')
          .filter('emailSignin', '=', key)
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

function getAdminEmails() {
  if (process.env.ADMIN_EMAILS) {
    try { return JSON.parse(process.env.ADMIN_EMAILS); } catch (e) {}
  }
  return (config.auth && config.auth.adminEmails) || [];
}

function isAdminEmail(email) {
  return getAdminEmails().some(function(a) { return a.toLowerCase() === email.toLowerCase(); });
}

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

module.exports = { isApprovedInstructor, isAdminEmail, isApprovedToSignup };
