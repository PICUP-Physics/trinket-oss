// LTI AGS — post a "submitted, pending manual grade" Score with Canvas's submission extension, so a
// trinket submission becomes reviewable in the LMS grader. NO numeric score: the human grades in the
// LMS. Pure HTTP; portable.
'use strict';
var ltiServiceToken = require('./ltiServiceToken');

var SCORE_SCOPE   = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
var SUBMISSION_EXT = 'https://canvas.instructure.com/lti/submission';

function buildScore(args) {
  var body = {
    userId: String(args.userId),
    timestamp: args.submittedAt instanceof Date ? args.submittedAt.toISOString() : new Date().toISOString(),
    activityProgress: 'Submitted',
    gradingProgress: 'PendingManual'
  };
  body[SUBMISSION_EXT] = {
    new_submission: true,
    submission_type: 'basic_lti_launch',
    submission_data: args.reviewUrl,
    submitted_at: body.timestamp
  };
  return body;
}

function doPost(lineItemUrl, token, scoreBody) {
  var parsed = new URL(lineItemUrl);
  parsed.pathname = parsed.pathname.replace(/\/?$/, '') + '/scores';
  var url = parsed.toString();
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.ims.lis.v1.score+json', authorization: 'Bearer ' + token },
    body: JSON.stringify(scoreBody)
  });
}

function postSubmission(platform, lineItemUrl, args) {
  var scoreBody = buildScore(args);
  return ltiServiceToken.getToken(platform, SCORE_SCOPE).then(function(token) {
    return doPost(lineItemUrl, token, scoreBody).then(function(res) {
      if (res.status === 401) {
        ltiServiceToken._clearCache();
        return ltiServiceToken.getToken(platform, SCORE_SCOPE).then(function(t2) {
          return doPost(lineItemUrl, t2, scoreBody);
        });
      }
      return res;
    });
  }).then(function(res) {
    if (!res.ok) throw new Error('AGS score POST returned HTTP ' + res.status);
  });
}

module.exports = { buildScore: buildScore, postSubmission: postSubmission, SCORE_SCOPE: SCORE_SCOPE };
