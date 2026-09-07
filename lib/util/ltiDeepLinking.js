// LTI Deep Linking (lti-dl) — pure seam. Builds the content items trinket returns to a platform
// and signs the Deep Linking Response JWT with the Tool key. No Hapi/HTTP coupling; no Datastore.
'use strict';
var config  = require('config');
var crypto  = require('crypto');
var ltiKeys = require('./ltiKeys');

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
var DL  = 'https://purl.imsglobal.org/spec/lti-dl/claim/';

function launchUrl() { return config.url + '/lti/launch'; }

// Assignment placement: a gradeable resource link. The lineItem makes the LMS create the gradebook
// column; the custom param drives trinket's existing ltiTarget resolution.
function assignmentContentItem(opts) {
  return {
    type:    'ltiResourceLink',
    title:   opts.title,
    url:     launchUrl(),
    custom:  { trinket_course: String(opts.courseId), trinket_assignment: String(opts.materialId) },
    lineItem: { scoreMaximum: (typeof opts.scoreMaximum === 'number' ? opts.scoreMaximum : 1),
                label: opts.title }
  };
}

// Course/topic/page placement: a plain resource link, no lineItem. Always carries
// trinket_course (the resolution + enrollment unit). A topic link adds
// trinket_topic (the lesson id); a PAGE link adds trinket_page (the material id).
//
// A page is the one an instructor usually wants (#13): a topic has no URL of its
// own, so a topic link can only land on the topic's first material — a page the
// instructor did not choose. A page carries the same coordinates an assignment
// does, but never a lineItem: linking a page is not creating gradable work.
function linkContentItem(opts) {
  var custom = { trinket_course: String(opts.courseId) };
  if (opts.lessonId) custom.trinket_topic = String(opts.lessonId);
  if (opts.pageId)   custom.trinket_page  = String(opts.pageId);
  return { type: 'ltiResourceLink', title: opts.title, url: launchUrl(), custom: custom };
}

// Sign the Deep Linking Response (LTI-DL §3.2). iss = our client_id for this platform,
// aud = the platform issuer. Echoes deployment_id and the opaque settings.data.
function buildDeepLinkingResponse(args) {
  var platform = args.platform || {};
  var settings = args.settings || {};
  var payload = {};
  payload.iss = platform.clientId;
  payload.aud = platform.issuer;
  payload[LTI + 'message_type'] = 'LtiDeepLinkingResponse';
  payload[LTI + 'version']      = '1.3.0';
  payload[LTI + 'deployment_id'] = args.deploymentId;
  // nonce is REQUIRED on every LTI message (security framework). Canvas tolerates
  // its absence on the DL response; D2L/Brightspace rejects the return without it.
  payload.nonce = crypto.randomBytes(16).toString('hex');
  payload[DL + 'content_items'] = args.contentItems || [];
  if (settings.data !== undefined) payload[DL + 'data'] = settings.data;
  return ltiKeys.signJwt(payload, { expiresIn: '5m' });
}

module.exports = {
  assignmentContentItem: assignmentContentItem,
  linkContentItem: linkContentItem,
  buildDeepLinkingResponse: buildDeepLinkingResponse
};
