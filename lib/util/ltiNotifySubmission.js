// Best-effort: when a student submits an LTI-launched assignment, announce the submission to the LMS
// gradebook (AGS Score, no grade) so it is reviewable in the LMS grader. Never throws to the caller.
'use strict';
var config          = require('config');
var LtiResourceLink = require('../models/ltiResourceLink');
var LtiPlatform     = require('../models/ltiPlatform');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var ltiAgs          = require('./ltiAgs');

function findAssignmentLinkP(courseId, materialId) {
  return new Promise(function(resolve) {
    LtiResourceLink.findAssignmentLink(courseId, materialId, function(err, link) { resolve(err ? null : link); });
  });
}
function findPlatformP(id) {
  return new Promise(function(resolve) { LtiPlatform.findById(id, function(err, p) { resolve(err ? null : p); }); });
}
function findSubP(userId, iss) {
  return new Promise(function(resolve) {
    LtiUserIdentity.findByUserAndIss(userId, iss, function(err, idn) { resolve(err ? null : idn); });
  });
}

function notify(submission) {
  var userId = submission._creator && submission._creator.toString ? submission._creator.toString() : submission._creator;
  return findAssignmentLinkP(submission.courseId, submission.materialId).then(function(link) {
    if (!link || !link.agsLineItemUrl) return null;   // not an LTI assignment → no-op
    return findPlatformP(link.platformId).then(function(platform) {
      if (!platform) return null;
      return findSubP(userId, platform.issuer).then(function(identity) {
        if (!identity) return null;
        var reviewUrl = config.url + '/lti/review/' + submission.id;
        return ltiAgs.postSubmission(platform, link.agsLineItemUrl, {
          userId: identity.sub, reviewUrl: reviewUrl, submittedAt: submission.submittedOn || new Date()
        });
      });
    });
  }).catch(function(e) {
    console.error('[lti] submission notify failed (best-effort):', e && e.message);
    return null;
  });
}

module.exports = { notify: notify };
