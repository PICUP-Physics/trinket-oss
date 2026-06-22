// LTI Advantage service token: client_credentials grant with a private_key_jwt client-assertion
// (signed by the Tool key). Caches the bearer per (platform, scope). Pure HTTP + crypto; portable.
'use strict';
var crypto  = require('crypto');
var ltiKeys = require('./ltiKeys');

var JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
var _cache = {};   // key -> { token, expiresAt }

function clientAssertion(platform) {
  var now = Math.floor(Date.now() / 1000);
  return ltiKeys.signJwt({
    iss: platform.clientId,
    sub: platform.clientId,
    aud: platform.authTokenUrl,
    iat: now,
    jti: crypto.randomBytes(16).toString('hex')
  }, { expiresIn: '5m' });
}

function getToken(platform, scope) {
  var key = String(platform.id) + '|' + scope;
  var hit = _cache[key];
  if (hit && hit.expiresAt > Date.now() + 60000) return Promise.resolve(hit.token);

  var body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_assertion_type', JWT_BEARER);
  body.set('client_assertion', clientAssertion(platform));
  body.set('scope', scope);

  return fetch(platform.authTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }).then(function(res) {
    if (!res.ok) throw new Error('AGS token endpoint returned HTTP ' + res.status);
    return res.json();
  }).then(function(json) {
    var ttl = (json.expires_in || 3600) * 1000;
    _cache[key] = { token: json.access_token, expiresAt: Date.now() + ttl };
    return json.access_token;
  });
}

module.exports = { getToken: getToken, _clearCache: function() { _cache = {}; } };
