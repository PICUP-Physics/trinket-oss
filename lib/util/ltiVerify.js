// Launch-JWT verification — the SOLE place `jose` is used, so it can be swapped without touching
// the launch controller (LTI-SPEC §11; upstream-dependency seam). Verifies a platform's LTI 1.3
// launch id_token against that platform's JWKS (fetched remotely, cached, with kid rotation).
var jose = require('jose');

var _sets = {};  // jwksUrl -> remote JWK set, cached across launches (per-instance is fine)

function jwksFor(url) {
  if (!_sets[url]) _sets[url] = jose.createRemoteJWKSet(new URL(url));
  return _sets[url];
}

// Promise of the verified claims; rejects on bad signature / issuer / audience / expiry.
module.exports.verifyLaunchToken = function(idToken, platform) {
  return jose.jwtVerify(idToken, jwksFor(platform.jwksUrl), {
    issuer     : platform.issuer,
    audience   : platform.clientId,
    algorithms : ['RS256']
  }).then(function(result) {
    return result.payload;
  });
};
