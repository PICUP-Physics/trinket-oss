// LTI Dynamic Registration (SP2) — the testable seam. Pure-ish: builds the tool-configuration
// trinket POSTs to a platform, maps the platform's response onto LtiPlatform fields, and (in later
// tasks) performs the SSRF-guarded outbound fetch/POST and mints/activates records. No Hapi/HTTP
// framework coupling. Portable: no @google-cloud/datastore. Mirrors the ltiVerify/ltiTarget seams.
'use strict';
var config = require('config');

var LTI_TOOL_CONFIG     = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
var LTI_PLATFORM_CONFIG = 'https://purl.imsglobal.org/spec/lti-platform-configuration';

// The OpenID Client Registration + LTI tool-config object trinket POSTs to the platform's
// registration_endpoint. v1: LtiResourceLinkRequest only; private_key_jwt + jwks_uri but NO AGS.
function buildToolConfiguration() {
  var base = config.url;
  var logo = base + '/img/logo.png';
  var doc = {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['client_credentials', 'implicit'],
    initiate_login_uri: base + '/lti/login',
    redirect_uris: [base + '/lti/launch'],
    jwks_uri: base + '/lti/jwks',
    client_name: 'Trinket',
    logo_uri: logo,
    token_endpoint_auth_method: 'private_key_jwt',
    scope: ''
  };
  doc[LTI_TOOL_CONFIG] = {
    domain: require('url').parse(base).host,
    target_link_uri: base + '/lti/launch',
    claims: ['iss', 'sub', 'name', 'given_name', 'family_name', 'email'],
    messages: [{ type: 'LtiResourceLinkRequest' }]
  };
  return doc;
}

// Map a platform's openid-configuration + registration response onto LtiPlatform fields.
function toPlatformFields(openidConfig, registrationResponse) {
  openidConfig = openidConfig || {};
  registrationResponse = registrationResponse || {};
  var platCfg = openidConfig[LTI_PLATFORM_CONFIG] || {};
  var toolCfg = registrationResponse[LTI_TOOL_CONFIG] || {};
  var productFamily = platCfg.product_family_code;
  var deploymentIds = toolCfg.deployment_id ? [toolCfg.deployment_id] : [];
  return {
    issuer: openidConfig.issuer,
    authLoginUrl: openidConfig.authorization_endpoint,
    authTokenUrl: openidConfig.token_endpoint,
    jwksUrl: openidConfig.jwks_uri,
    clientId: registrationResponse.client_id,
    deploymentIds: deploymentIds,
    productFamily: productFamily,
    name: productFamily ? (productFamily + ' (' + openidConfig.issuer + ')') : openidConfig.issuer
  };
}

module.exports = {
  buildToolConfiguration: buildToolConfiguration,
  toPlatformFields: toPlatformFields
};
