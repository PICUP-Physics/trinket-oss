// LTI 1.3 Tool keypair handling. trinket signs Tool JWTs (Deep Linking/AGS later) and exposes
// the matching public key at GET /lti/jwks. One keypair, shared across all platforms (LTI-SPEC
// §11). The private key arrives via env LTI_PRIVATE_KEY (from Secret Manager on Cloud Run, .env
// locally) as either a raw PEM or a base64-encoded PEM — base64 is the env-friendly form.
var crypto = require('crypto');
var config = require('config');
var jwt    = require('jsonwebtoken');

var _cache = null;

// Raw PEM string, or null if not configured.
function loadPem() {
  var raw = process.env.LTI_PRIVATE_KEY
    || (config.app && config.app.lti && config.app.lti.privateKey);
  if (!raw) return null;
  raw = String(raw).trim();
  // Accept base64-wrapped PEM (single-line, env-friendly) or a raw PEM.
  if (raw.indexOf('-----BEGIN') !== 0) {
    raw = Buffer.from(raw, 'base64').toString('utf8').trim();
  }
  return raw;
}

// RFC 7638 JWK thumbprint (SHA-256, base64url) over the canonical RSA public JWK. Stable id for
// the key, so platforms can match the `kid` in a signed JWT header to this JWKS entry.
function thumbprint(jwk) {
  var canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function load() {
  if (_cache) return _cache;
  var pem = loadPem();
  if (!pem) return null;
  var privateKey = crypto.createPrivateKey(pem);
  var publicKey  = crypto.createPublicKey(privateKey);
  var publicPem  = publicKey.export({ type: 'spki', format: 'pem' });
  var publicJwk  = publicKey.export({ format: 'jwk' });
  publicJwk.kid = thumbprint(publicJwk);
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  _cache = { privateKey: privateKey, pem: pem, publicPem: publicPem, publicJwk: publicJwk, kid: publicJwk.kid };
  return _cache;
}

module.exports = {
  isConfigured : function() { return !!loadPem(); },
  getPrivateKey: function() { var k = load(); return k && k.privateKey; },
  getPublicJwk : function() { var k = load(); return k && k.publicJwk; },
  getKid       : function() { var k = load(); return k && k.kid; },

  // Sign/verify a Tool-issued JWT with this keypair (RS256). Used for the stateless `state`
  // token (LTI-SPEC §7.1); reused later for Deep Linking / AGS.
  signJwt: function(payload, options) {
    var k = load();
    if (!k) throw new Error('LTI private key not configured (LTI_PRIVATE_KEY)');
    var opts = Object.assign({ algorithm: 'RS256' }, options || {});
    opts.headers = Object.assign({ kid: k.kid }, opts.headers || {});
    return jwt.sign(payload, k.pem, opts);
  },
  verifyJwt: function(token, options) {
    var k = load();
    if (!k) throw new Error('LTI private key not configured (LTI_PRIVATE_KEY)');
    return jwt.verify(token, k.publicPem, Object.assign({ algorithms: ['RS256'] }, options || {}));
  }
};
