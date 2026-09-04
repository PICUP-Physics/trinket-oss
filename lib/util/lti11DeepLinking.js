// LTI 1.1 Deep Linking (IMS Content-Item Message) — the 1.1 counterpart of
// ltiDeepLinking. Pure seam: builds the content-item graph and the OAuth-signed
// form fields posted back to the platform. No Hapi/HTTP coupling.
//
// The two versions differ only at the edges:
//   1.3  returns ONE signed JWT (`JWT` form field), items as JSON claims
//   1.1  returns a JSON-LD @graph in a `content_items` form field, with the whole
//        form OAuth 1.0a-signed using the consumer secret
// The picker UI and the selection the instructor makes are identical, so both
// share the picker and the session contract.
//
// Signing note: this body is form-encoded, so its parameters DO go into the
// signature base and no oauth_body_hash is involved — the opposite of
// lti11Outcomes, whose XML body has no parameters to fold in.
'use strict';
var crypto = require('crypto');
var config = require('config');
var lti11Verify = require('./lti11Verify');

var CTX = 'http://purl.imsglobal.org/ctx/lti/v1/ContentItem';

function launchUrl() { return config.url + '/lti11/launch'; }

// Targeting goes in the URL as well as in `custom`.
//
// Canvas does not honour the `custom` map on a 1.1 content item: observed live on
// canvas.spvi.net, every launch from a deep-linked item arrived with NO
// trinket_course, so resolveTarget returned {course:null} and the student landed on
// their own trinkets instead of the assignment. The URL, by contrast, Canvas stores
// verbatim and replays on every launch.
//
// Both are sent. `custom` is correct per the IMS spec and platforms that honour it
// keep working; the query string is what actually survives Canvas. Query params are
// folded into the OAuth signature base, so this is only usable because the launch
// verifier now merges body+query (see controllers/lti.js).
function targetedUrl(params) {
  var qs = Object.keys(params)
    .filter(function (k) { return params[k]; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  return qs ? launchUrl() + '?' + qs : launchUrl();
}

// A gradeable placement. lineItem is what makes the LMS create a gradebook column
// — and therefore what makes it send lis_outcome_service_url on later launches,
// without which nothing can ever be reported back (see lti11Outcomes).
function assignmentContentItem(opts) {
  var max = (typeof opts.scoreMaximum === 'number') ? opts.scoreMaximum : 100;
  return {
    '@type'  : 'LtiLinkItem',
    mediaType: 'application/vnd.ims.lti.v1.ltilink',
    title    : opts.title,
    url      : targetedUrl({ course: opts.courseId, assignment: opts.materialId }),
    custom   : { trinket_course: String(opts.courseId), trinket_assignment: String(opts.materialId) },
    lineItem : {
      '@type': 'LineItem',
      label  : opts.title,
      reportingMethod: 'res:totalScore',
      scoreConstraints: { '@type': 'NumericLimits', normalMaximum: max, totalMaximum: max }
    }
  };
}

// Course/topic/page placement: no lineItem, so no gradebook column. Canvas
// ignores custom on 1.1 items and replays the stored URL verbatim, so the
// targeting has to ride in the URL too — page included (#13).
function linkContentItem(opts) {
  var custom = { trinket_course: String(opts.courseId) };
  if (opts.lessonId) custom.trinket_topic = String(opts.lessonId);
  if (opts.pageId)   custom.trinket_page  = String(opts.pageId);
  return {
    '@type'  : 'LtiLinkItem',
    mediaType: 'application/vnd.ims.lti.v1.ltilink',
    title    : opts.title,
    url      : targetedUrl({ course: opts.courseId, topic: opts.lessonId, page: opts.pageId }),
    custom   : custom
  };
}

function contentItemsJson(items) {
  return JSON.stringify({ '@context': CTX, '@graph': items || [] });
}

// The form fields to POST back to content_item_return_url. Everything here is
// signed together: a platform that finds content_items altered will reject it.
function buildReturnForm(args) {
  var opts = args.opts || {};
  var params = {
    lti_message_type      : 'ContentItemSelection',
    lti_version           : 'LTI-1p0',
    content_items         : contentItemsJson(args.contentItems),
    oauth_consumer_key    : args.consumerKey,
    oauth_nonce           : opts.nonce || crypto.randomBytes(12).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp       : String(opts.timestamp || Math.floor(Date.now() / 1000)),
    oauth_version         : '1.0',
    oauth_callback        : 'about:blank'
  };
  // Opaque platform state — echoed back verbatim when present. Canvas omits it;
  // other platforms rely on it to correlate the response with the request.
  if (args.data !== undefined && args.data !== null && args.data !== '') {
    params.data = String(args.data);
  }
  params.oauth_signature = lti11Verify.sign('POST', args.returnUrl, params, args.secret);
  return params;
}

module.exports = {
  assignmentContentItem: assignmentContentItem,
  linkContentItem: linkContentItem,
  contentItemsJson: contentItemsJson,
  buildReturnForm: buildReturnForm,
  launchUrl: launchUrl
};
