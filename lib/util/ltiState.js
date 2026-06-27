// Stateless LTI `state` token (LTI-SPEC §7.1). Instead of storing state/nonce server-side
// (gcr has no shared cache — Store is per-instance), `state` is a short-lived JWT signed by the
// Tool key, carrying the nonce + launch context. /lti/login signs it; /lti/launch verifies it
// (signature + expiry) and checks the embedded nonce against the id_token. Nothing is stored.
var ltiKeys = require('./ltiKeys');

var STATE_TTL = '5m';

module.exports = {
  // data: { nonce, iss, clientId, target }
  sign: function(data) {
    return ltiKeys.signJwt({
      typ   : 'lti-state',
      nonce : data.nonce,
      iss   : data.iss,
      cid   : data.clientId,
      tgt   : data.target
    }, { expiresIn: STATE_TTL });
  },

  // Throws on bad signature, expiry, or wrong type. Returns the decoded payload.
  verify: function(token) {
    var payload = ltiKeys.verifyJwt(token);
    if (!payload || payload.typ !== 'lti-state') {
      throw new Error('not an lti-state token');
    }
    return payload;
  }
};
