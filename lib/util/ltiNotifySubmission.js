// Best-effort: when a student submits an LTI-launched assignment, announce the submission to the LMS
// gradebook (AGS Score, no grade) so it is reviewable in the LMS grader. Never throws to the caller.
'use strict';
var config          = require('config');
var LtiResourceLink = require('../models/ltiResourceLink');
var LtiPlatform     = require('../models/ltiPlatform');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var LtiOutcome      = require('../models/ltiOutcome');
var LtiConsumer     = require('../models/ltiConsumer');
var Trinket         = require('../models/trinket');
var ltiAgs          = require('./ltiAgs');
var lti11Outcomes   = require('./lti11Outcomes');
var ltiOutcomeContext = require('./ltiOutcomeContext');
var ltiReview       = require('./ltiReview');

function findAssignmentLinkP(courseId, materialId) {
  return new Promise(function(resolve) {
    LtiResourceLink.findAssignmentLink(courseId, materialId, function(err, link) { resolve(err ? null : link); });
  });
}
function findPlatformP(id) {
  return new Promise(function(resolve) { LtiPlatform.findById(id, function(err, p) { resolve(err ? null : p); }); });
}
function findOutcomeP(platformId, resourceLinkId, userId) {
  return new Promise(function(resolve) {
    LtiOutcome.findForPlacement(platformId, resourceLinkId, userId, function(err, rec) { resolve(err ? null : rec); });
  });
}
function findConsumerP(key) {
  return new Promise(function(resolve) {
    LtiConsumer.findByKey(key, function(err, c) { resolve(err ? null : c); });
  });
}

// Remember which 1.1 token this submission has been announced against, so a
// later launch can tell "already reported" from "never reported". Best-effort
// and deliberately after the post: if the save fails we will simply report
// again next launch, which is harmless, whereas marking before the post would
// lose the submission for good if the post then failed.
function markReported(submission, sourcedId) {
  if (!submission || !sourcedId || typeof submission.save !== 'function') return Promise.resolve(null);
  submission.ltiReportedSourcedId = sourcedId;
  submission.ltiReportedAt = new Date();
  function done() { return null; }
  return Promise.resolve().then(function () { return submission.save(); }).then(done, done);
}

// LTI 1.1 has no AGS: replaceResult with resultData/ltiLaunchUrl is the only way to
// tell the platform a submission exists and where to view it. Platform ids for 1.1
// are synthesized as 'lti11:<consumer key>' at launch (see controllers/lti.js).
function notify11(link, userId, reviewUrl, submission) {
  return ltiOutcomeContext.resolveFor(submission, userId, { link: link }).then(function (ctx) {
    if (!ctx.consumer) {
      // The common one is 'no outcome coordinates for this student': 1.1 can
      // only post with a per-(student, placement) sourcedid, and we only get
      // one when that student launches that graded placement. Logged rather
      // than swallowed — notifyOnCoordinates exists to repair exactly this.
      say('skipped (1.1) — ' + ctx.reason, submission, { user: userId });
      return null;
    }
    return lti11Outcomes.postSubmission({
      serviceUrl : ctx.outcome.serviceUrl,
      consumerKey: ctx.consumer.key,
      secret     : ctx.consumer.secret,
      sourcedId  : ctx.outcome.sourcedId,
      launchUrl  : reviewUrl
      // no score: trinket has no concept of a grade
    }).then(function (res) {
      say('reported to the LMS (1.1 Basic Outcomes)', submission, { user: userId });
      return markReported(submission, ctx.outcome.sourcedId).then(function () { return res; });
    });
  });
}

function findSubP(userId, iss) {
  return new Promise(function(resolve) {
    LtiUserIdentity.findByUserAndIss(userId, iss, function(err, idn) { resolve(err ? null : idn); });
  });
}

// The creator's user ID, whatever shape `_creator` arrives in. Mongoose casts
// the assignment `_creator: request.user` to an ObjectId, so toString() was the
// id; the Firestore model layer keeps the user DOCUMENT in memory (it coerces
// to an id only at write time), so toString() there was "[object Object]" and
// the identity lookup silently found nothing — the AGS needs-grading call
// never fired on any Firestore deploy. Found live in the 2026-08-24 Canvas
// rehearsal; pinned by test/lib/util/ltiNotifySubmission.test.js.
function creatorId(creator) {
  if (!creator) return creator;
  if (typeof creator === 'object') {
    if (typeof creator._id !== 'undefined') return String(creator._id);
    if (typeof creator.id  !== 'undefined') return String(creator.id);
  }
  return String(creator);
}

// Every exit below used to be silent, including success. That is why a live
// course could report half its submissions to the LMS and none of the other
// half with nothing in the logs to say so — it took a database reconciliation
// to find. One line per outcome makes the next case readable straight from the
// request log.
function say(what, submission, extra) {
  console.log('[lti] submission notify: ' + what,
    Object.assign({ submission: submission && submission.id,
                    material: submission && submission.materialId }, extra || {}));
}

// opts.link lets a caller that already knows the exact placement hand it in.
// The late-report path does: it found the placement by resource_link_id, which
// is exact, and re-resolving by (course, material) would throw that precision
// away and re-open the duplicate-placement question for no reason.
function notify(submission, opts) {
  var userId = creatorId(submission._creator);
  var linkP = (opts && opts.link)
    ? Promise.resolve(opts.link)
    : findAssignmentLinkP(submission.courseId, submission.materialId);
  return linkP.then(function(link) {
    if (!link) { say('skipped — material is not an LTI assignment', submission); return null; }
    // The two versions get DIFFERENT review URLs, because only one of them has to
    // be matched back to an installed tool. See ltiReview.advertisedUrl.
    if (!link.agsLineItemUrl) {
      return notify11(link, userId,
                      ltiReview.advertisedUrl(config.url, submission.id, { version: '1.1' }),
                      submission);
    }
    var reviewUrl = ltiReview.advertisedUrl(config.url, submission.id);
    return findPlatformP(link.platformId).then(function(platform) {
      if (!platform) { say('skipped (1.3) — platform record missing', submission); return null; }
      return findSubP(userId, platform.issuer).then(function(identity) {
        if (!identity) {
          say('skipped (1.3) — no LTI identity for this user on ' + platform.issuer, submission, { user: userId });
          return null;
        }
        return ltiAgs.postSubmission(platform, link.agsLineItemUrl, {
          userId: identity.sub, reviewUrl: reviewUrl, submittedAt: submission.submittedOn || new Date()
        }).then(function (res) {
          say('reported to the LMS (1.3 AGS)', submission, { user: userId });
          return res;
        });
      });
    });
  }).catch(function(e) {
    console.error('[lti] submission notify failed (best-effort):', e && e.message);
    return null;
  });
}

// Report a submission whose Basic Outcomes coordinates only arrived LATER.
//
// 1.1 can report a submission only with a per-(student, placement) sourcedid,
// handed over just when that student launches that graded assignment. A student
// who reached the work another way — a course or topic link, a bookmark — and
// submitted had no coordinates at submit time, so notify() no-opped and the LMS
// grader said "nothing submitted" while the work sat in trinket. Measured on a
// live course: 135 of 273 student-assignment pairs had no coordinates.
//
// Called from EVERY graded 1.1 launch, not only the one that first captures a
// token. That matters: gating on "is this token new" would permanently skip
// every student who had already clicked their assignment before this code
// existed, because nothing about their token is new. Idempotence comes instead
// from the marker on the submission (ltiReportedSourcedId) — which also means a
// post the platform rejected is retried on the next launch rather than lost.
// Best-effort like everything on this path: a launch must never fail over
// gradebook bookkeeping.
function notifyOnCoordinates(platformId, resourceLinkId, userId, sourcedId) {
  return Promise.resolve().then(function () {
    return new Promise(function (resolve) {
      LtiResourceLink.findByLink(platformId, resourceLinkId, function (err, link) {
        resolve(err ? null : link);
      });
    });
  }).then(function (link) {
    // Only a graded assignment placement can carry a submission. A topic or
    // course link legitimately has nothing to report.
    if (!link || link.targetType !== 'assignment' || !link.targetId) return null;
    return Promise.resolve(Trinket.findByUserAndMaterial(userId, link.targetId))
      .then(function (list) {
        // findByUserAndMaterial sorts newest first; only submitted work counts,
        // an in-progress draft is not a submission.
        var submission = (list || []).filter(function (t) { return t && t.submittedOn; })[0];
        if (!submission) return null;
        // Already announced against this very token: the routine relaunch case.
        if (sourcedId && submission.ltiReportedSourcedId === sourcedId) return null;
        say('coordinates available — reporting an unannounced submission', submission,
            { user: userId, previouslyReportedAgainst: submission.ltiReportedSourcedId || null });
        return notify(submission, { link: link });
      });
  }).catch(function (e) {
    console.error('[lti] late-coordinate notify failed (best-effort):', e && e.message);
    return null;
  });
}

module.exports = {
  notify: notify,
  notifyOnCoordinates: notifyOnCoordinates,
  creatorId: creatorId
};
