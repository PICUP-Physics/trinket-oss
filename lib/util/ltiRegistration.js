// LTI Dynamic Registration (SP2) — the testable seam. Pure-ish: builds the tool-configuration
// trinket POSTs to a platform, maps the platform's response onto LtiPlatform fields, and (in later
// tasks) performs the SSRF-guarded outbound fetch/POST and mints/activates records. No Hapi/HTTP
// framework coupling. Portable: no @google-cloud/datastore. Mirrors the ltiVerify/ltiTarget seams.
'use strict';
var config = require('config');
var crypto = require('crypto');
var dns = require('dns');
var urlmod = require('url');

var FETCH_TIMEOUT_MS = 5000;
var MAX_BYTES = 256 * 1024;

// RFC1918 / loopback / link-local / unique-local checks (v4 + v6).
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.indexOf(':') >= 0) {  // IPv6
    var l = ip.toLowerCase();
    // Detect IPv6-mapped IPv4 (e.g. ::ffff:169.254.169.254 or ::ffff:10.0.0.1) and re-evaluate
    // the embedded IPv4 through the existing IPv4 logic — prevents SSRF bypass via mapped form.
    var mappedV4 = l.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedV4) return isPrivateIp(mappedV4[1]);
    return l === '::1' || l.indexOf('fc') === 0 || l.indexOf('fd') === 0 || l.indexOf('fe80') === 0 || l === '::';
  }
  var o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(function (n) { return isNaN(n); })) return true;
  if (o[0] === 10) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 0) return true;
  return false;
}

function allowPrivate() {
  return !!(config.lti && config.lti.allowPrivateRegistrationHosts);
}

// Resolve (Promise) iff the URL is https (or the dev flag is set) and its host does not resolve to a
// private/loopback/link-local address. Reject otherwise. Defense-in-depth against SSRF.
function assertFetchableUrl(urlString) {
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new urlmod.URL(urlString); } catch (e) { return reject(new Error('Malformed registration URL')); }
    if (u.protocol !== 'https:' && !allowPrivate()) return reject(new Error('Registration endpoints must use https'));
    if (allowPrivate()) return resolve();   // dev/test: skip the DNS/private-range check
    dns.lookup(u.hostname, { all: true }, function (err, addrs) {
      if (err) return reject(new Error('Cannot resolve registration host'));
      var bad = (addrs || []).some(function (a) { return isPrivateIp(a.address); });
      if (bad) return reject(new Error('Registration host resolves to a disallowed address'));
      resolve();
    });
  });
}

function fetchWithLimits(urlString, options) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT_MS);
  options = Object.assign({}, options || {}, { signal: ac.signal, redirect: 'error' });
  return assertFetchableUrl(urlString)
    .then(function () { return fetch(urlString, options); })
    .then(function (res) {
      if (!res.ok) throw new Error('Registration endpoint returned HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) {
      if (text.length > MAX_BYTES) throw new Error('Registration response too large');
      try { return JSON.parse(text); } catch (e) { throw new Error('Registration endpoint returned non-JSON'); }
    })
    .finally(function () { clearTimeout(timer); });
}

function fetchPlatformConfig(openidConfigurationUrl) {
  return fetchWithLimits(openidConfigurationUrl, { method: 'GET', headers: { accept: 'application/json' } });
}

function register(openidConfig, registrationToken) {
  var endpoint = openidConfig && openidConfig.registration_endpoint;
  if (!endpoint) return Promise.reject(new Error('Platform openid-config has no registration_endpoint'));
  var headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (registrationToken) headers.authorization = 'Bearer ' + registrationToken;
  return fetchWithLimits(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(buildToolConfiguration()) });
}

var LTI_TOOL_CONFIG     = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
var LTI_PLATFORM_CONFIG = 'https://purl.imsglobal.org/spec/lti-platform-configuration';

// The OpenID Client Registration + LTI tool-config object trinket POSTs to the platform's
// registration_endpoint. v1: LtiResourceLinkRequest only; private_key_jwt + jwks_uri but NO AGS.
function buildToolConfiguration() {
  var base = config.url;
  // LMS tool icon = the Trinket logomark (the tool identity). The DISPLAY NAME,
  // however, is per-deploy: multiple Trinket servers can register into one LMS,
  // and a shared "Trinket" name makes their Developer Keys / Apps entries
  // indistinguishable. config.lti.toolName lets each deploy self-identify (e.g.
  // "UIndy Trinket", "M&I Trinket"); falls back to "Trinket" when unset.
  var toolName = (config.lti && config.lti.toolName) || 'Trinket';
  var logo = base + '/img/trinket-logo-circles.png';
  var doc = {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['client_credentials', 'implicit'],
    initiate_login_uri: base + '/lti/login',
    redirect_uris: [base + '/lti/launch'],
    jwks_uri: base + '/lti/jwks',
    client_name: toolName,
    logo_uri: logo,
    token_endpoint_auth_method: 'private_key_jwt',
    scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/score'
  };
  doc[LTI_TOOL_CONFIG] = {
    domain: require('url').parse(base).host,
    target_link_uri: base + '/lti/launch',
    claims: ['iss', 'sub', 'name', 'given_name', 'family_name', 'email'],
    // Only deep-linking messages: assignment_selection (graded) + link_selection (course/topic).
    // A placement-less LtiResourceLinkRequest message must NOT be listed — Canvas defaults such a
    // message to the link_selection placement as a *direct launch*, which collides with (and wins
    // over) the deep-linking link_selection here, so the content picker never opens. Resource-link
    // launches of already-placed content still work via the top-level target_link_uri.
    messages: [
      { type: 'LtiDeepLinkingRequest', placements: ['assignment_selection', 'link_selection'] }
    ]
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

// Mint a single-use registration token, persist its hash, and return the raw token + the URL the
// instructor hands to their LMS admin. DRY anchor: the Connect-your-LMS controller and any future
// CLI both call this — they do not re-implement token logic.
function mintRegistrationToken(opts) {
  opts = opts || {};
  var LtiRegistrationToken = require('../models/ltiRegistrationToken');
  var ttlDays = (typeof opts.ttlDays === 'number' && opts.ttlDays > 0) ? opts.ttlDays : 7;
  var rawToken = crypto.randomBytes(32).toString('base64url');
  var token = new LtiRegistrationToken({
    tokenHash: LtiRegistrationToken.hashToken(rawToken),
    label: opts.label,
    initiatedByEmail: opts.initiatedByEmail,
    expiresAt: new Date(Date.now() + ttlDays * 86400000)
  });
  return Promise.resolve(token.save()).then(function () {
    return { rawToken: rawToken, url: config.url + '/lti/register?reg_token=' + rawToken };
  });
}

// Activate a pending platform so its launches are honored. DRY anchor: the admin Approve handler and
// any future CLI both call this. Idempotent: already-active resolves; unknown rejects.
function activatePlatform(issuer, clientId) {
  var LtiPlatform = require('../models/ltiPlatform');
  return new Promise(function (resolve, reject) {
    LtiPlatform.findByIssuer(issuer, clientId, function (err, platform) {
      if (err) return reject(err);
      if (!platform) return reject(new Error('No registered platform for issuer ' + issuer));
      if (platform.status === 'active') return resolve(platform);
      platform.status = 'active';
      platform.save(function (saveErr) {
        if (saveErr) return reject(saveErr);
        resolve(platform);
      });
    });
  });
}

module.exports = {
  buildToolConfiguration: buildToolConfiguration,
  toPlatformFields: toPlatformFields,
  assertFetchableUrl: assertFetchableUrl,
  isPrivateIp: isPrivateIp,
  fetchPlatformConfig: fetchPlatformConfig,
  register: register,
  mintRegistrationToken: mintRegistrationToken,
  activatePlatform: activatePlatform
};
