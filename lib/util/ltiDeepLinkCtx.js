// Deep-linking context, carried in the URL instead of a cookie.
//
// WHY THIS EXISTS: a deep-linking launch arrives in an LMS iframe — a third-party
// context. Current browsers refuse third-party cookies outright, so the session the
// launch establishes cannot be stored, and the very next request (the picker) is
// anonymous. The instructor lands on a login page inside the frame even though they
// are already signed in to this deploy in the same browser. See issue #217.
//
// The fix is to stop depending on the cookie surviving: the launch signs the
// deep-linking context into a short-lived token and puts it in the picker URL. The
// picker then runs in a TOP-LEVEL tab, where the instructor's own first-party cookie
// works normally.
//
// ⚠️ THIS TOKEN DELIBERATELY CARRIES NO IDENTITY. It would have been simpler to put a
// user id in it and mint a session from it, but that turns any leaked URL — a
// referrer header, a screenshot in a support ticket, a proxy log — into a live
// session for that instructor. Authentication stays with the user's own cookie in a
// first-party context; this token only says WHICH deep-link request is being answered.
//
// Two further properties, both from review (finding 2):
//
//  * BOUND to the launcher. Without that the token is a transferable capability:
//    any signed-in user who obtains the URL could answer that LMS request with
//    their own content. The binding is `uh`, a keyed digest of the launching
//    user's id — it identifies nobody, but a session belonging to anyone else
//    fails to match and is refused. Where there is no session at all (the framed,
//    cookieless "Continue in a new tab" page) no check is possible, and none is
//    needed: nothing proceeds there.
//
//  * PRIVATE. The LMS's coordinates — return URL, its opaque `data`, consumer key,
//    platform issuer/client/deployment — sit in one AES-256-GCM blob; only
//    { typ, v, enc, iv, tag, uh, exp } is signed in the clear. A URL in browser
//    history or a log reveals the token's type and expiry and nothing else.
//
//    Replay within the 15-minute window by the SAME user remains possible and is
//    harmless: it answers their own LMS request, which the LMS itself dedupes.
//
// Keys: both the binding key and the encryption key are derived (HKDF-SHA256, with
// distinct `info` labels) from the tool's LTI private key material, which ltiKeys
// already loads and which sign() already requires to sign the JWT. Deriving from
// it rather than from the yar cookie password keeps this module on exactly ONE
// secret with ONE failure mode — no keypair, no token — and the cookie password is
// a per-deploy overlay value ('' in default.yaml) that would add a second thing a
// 1.1-only deploy must get right for a feature it cannot use anyway.
//
// Stateless by necessity as well as design: Cloud Run runs several instances with no
// shared cache, so a server-side token table would work only by luck. Same reasoning
// as ltiState.js, and the same signing key.
var crypto  = require('crypto');
var ltiKeys = require('./ltiKeys');

// Long enough for a human to click through a picker, short enough to be uninteresting
// if it leaks. The instructor can always relaunch from the LMS.
var CTX_TTL = '15m';
var TYP     = 'lti-dl-ctx';

var _derived = null;

// { bind, enc } — 32-byte keys, or null when no LTI keypair is configured. Cached
// only once derived, like ltiKeys' own cache, so a key that appears later (tests set
// it at first use) is picked up.
function derivedKeys() {
  if (_derived) return _derived;
  var pk = ltiKeys.getPrivateKey();
  if (!pk) return null;
  var ikm = pk.export({ type: 'pkcs8', format: 'der' });
  _derived = {
    bind: Buffer.from(crypto.hkdfSync('sha256', ikm, '', 'lti-dl-ctx/bind', 32)),
    enc : Buffer.from(crypto.hkdfSync('sha256', ikm, '', 'lti-dl-ctx/enc',  32))
  };
  return _derived;
}

// Keyed digest of the user id, truncated to 16 bytes. Not reversible, not
// comparable across deploys (different key), and never equal to the id itself.
function userDigest(keys, userId) {
  return crypto.createHmac('sha256', keys.bind).update(String(userId)).digest()
    .subarray(0, 16).toString('base64url');
}

function sameDigest(a, b) {
  var ab = Buffer.from(String(a || ''), 'base64url');
  var bb = Buffer.from(String(b || ''), 'base64url');
  return ab.length === 16 && bb.length === 16 && crypto.timingSafeEqual(ab, bb);
}

var NONE = { dl: null, mismatch: false };

module.exports = {
  TYP: TYP,

  // dl is the same shape stashed in the session by the launch; userId is the launching
  // user's id (bound, never carried). Only the fields the picker and the select step
  // actually need are carried; nothing about the user.
  //
  // Returns null rather than throwing when no signing key is configured. The token is
  // an ENHANCEMENT — it rescues the flow in browsers that drop the launch cookie — so
  // it must never be able to break a launch that would otherwise have worked. LTI 1.1
  // deep linking needs no 1.3 keypair, and a 1.1-only deploy has no LTI_PRIVATE_KEY;
  // signing unconditionally made every such launch fail (caught by
  // test/lib/api/lti11-deeplink.test.js). Also null without a userId: an unbound
  // token is exactly the transferable capability this module must not mint.
  sign: function (dl, userId) {
    if (!dl || !userId) return null;
    try {
      var keys = derivedKeys();
      if (!keys) return null;
      var iv = crypto.randomBytes(12);
      var cipher = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
      cipher.setAAD(Buffer.from(TYP));
      var plain = JSON.stringify({
        ru   : dl.deep_link_return_url,
        data : dl.data,
        mode : dl.mode,
        am   : !!dl.acceptMultiple,
        aa   : dl.assignmentAllowed !== false,
        ck   : dl.consumerKey || null,     // 1.1: which consumer to re-read the secret from
        pi   : dl.platformIss || null,     // 1.3: platform issuer
        pc   : dl.platformCid || null,     // 1.3: client id
        di   : dl.deploymentId || null
      });
      var enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ltiKeys.signJwt({
        typ : TYP,
        v   : dl.version,
        enc : enc.toString('base64url'),
        iv  : iv.toString('base64url'),
        tag : cipher.getAuthTag().toString('base64url'),
        uh  : userDigest(keys, userId)
      }, { expiresIn: CTX_TTL });
    } catch (e) {
      return null;   // no key configured: fall back to session-only behaviour
    }
  },

  // { dl, mismatch }. dl is the dl-shaped object, or null when the token is absent,
  // malformed, expired, of the wrong type, altered, or bound to someone else — in
  // that last case mismatch is true so the caller can say so instead of "expired".
  // userId is optional: when given (a session user is present) the binding MUST
  // match; when absent no user check is possible and none is made.
  check: function (token, userId) {
    if (!token) return NONE;
    var keys = derivedKeys();
    if (!keys) return NONE;
    var p;
    try { p = ltiKeys.verifyJwt(token); } catch (e) { return NONE; }
    if (!p || p.typ !== TYP || !p.enc || !p.iv || !p.tag || !p.uh) return NONE;
    if (userId !== undefined && userId !== null && userId !== '') {
      if (!sameDigest(p.uh, userDigest(keys, userId))) return { dl: null, mismatch: true };
    }
    var d;
    try {
      var decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(p.iv, 'base64url'));
      decipher.setAAD(Buffer.from(TYP));
      decipher.setAuthTag(Buffer.from(p.tag, 'base64url'));
      d = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(p.enc, 'base64url')), decipher.final()
      ]).toString('utf8'));
    } catch (e) {
      return NONE;   // altered blob, wrong key, or not JSON
    }
    if (!d || !d.ru) return NONE;
    return {
      mismatch: false,
      dl: {
        version              : p.v,
        deep_link_return_url : d.ru,
        data                 : d.data,
        mode                 : d.mode,
        acceptMultiple       : !!d.am,
        assignmentAllowed    : d.aa !== false,
        consumerKey          : d.ck || undefined,
        platformIss          : d.pi || undefined,
        platformCid          : d.pc || undefined,
        deploymentId         : d.di || undefined
      }
    };
  },

  // The dl-shaped object, or null. Callers treat null as "no context"; use check()
  // where the difference between a bad token and someone else's token matters.
  verify: function (token, userId) {
    return this.check(token, userId).dl;
  }
};
