// LTI Deep Linking (lti-dl) — pure seam. Builds the content items trinket returns to a platform
// and signs the Deep Linking Response JWT with the Tool key. No Hapi/HTTP coupling; no Datastore.
'use strict';
var config  = require('config');
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
    custom:  { trinket_assignment: String(opts.materialId) },
    lineItem: { scoreMaximum: (typeof opts.scoreMaximum === 'number' ? opts.scoreMaximum : 1),
                label: opts.title }
  };
}

// Course/topic placement: a plain resource link, no lineItem.
function linkContentItem(opts) {
  var custom = {};
  if (opts.targetType === 'topic') custom.trinket_topic = String(opts.targetId);
  else custom.trinket_course = String(opts.targetId);
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
  payload[DL + 'content_items'] = args.contentItems || [];
  if (settings.data !== undefined) payload[DL + 'data'] = settings.data;
  return ltiKeys.signJwt(payload, { expiresIn: '5m' });
}

module.exports = {
  assignmentContentItem: assignmentContentItem,
  linkContentItem: linkContentItem,
  buildDeepLinkingResponse: buildDeepLinkingResponse
};
