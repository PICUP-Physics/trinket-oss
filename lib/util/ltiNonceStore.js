// Nonce replay-protection store — the backend seam (LTI-SPEC §10.1). Firestore implementation
// now; a redis impl (`SET key 1 NX EX ttl`, naturally atomic) can be slotted in later for
// oss/upstream, selected off config.db.backend. Only the Firestore impl is built for v1.
//
// checkAndRecord(key, ttlSeconds) -> Promise<boolean>: true if the key was fresh (now recorded),
// false if it was already present (replay).
//
// NOTE: find-then-create has a small TOCTOU window. A hardened version should be atomic (nonce
// as the document id / unique index, or redis SET NX). Acceptable for v1; see LTI-SPEC §7.1.

function firestoreCheckAndRecord(key, ttlSeconds) {
  var LtiNonce = require('../models/ltiNonce');
  return new Promise(function(resolve, reject) {
    LtiNonce.findByNonce(key, function(err, existing) {
      if (err) return reject(err);
      if (existing) return resolve(false);
      var rec = new LtiNonce({ nonce: key, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
      rec.save(function(saveErr) {
        if (saveErr) return reject(saveErr);
        resolve(true);
      });
    });
  });
}

module.exports = {
  checkAndRecord: firestoreCheckAndRecord
};
