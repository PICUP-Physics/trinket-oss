// LTI launch nonce — replay protection only (LTI-SPEC §10). Each consumed launch nonce is
// recorded until it expires; a Firestore TTL policy on `expiresAt` auto-deletes old rows.
// Written/read through the ltiNonceStore seam (lib/util/ltiNonceStore.js).
var model = require('./model');

var schema = {
  nonce     : { type: String, required: true },
  expiresAt : { type: Date,   required: true }   // Firestore TTL field (auto-delete)
};

function findByNonce(nonce, cb) {
  return this.model.findOne({ nonce: nonce }, cb);
}

var LtiNonce = model.create('LtiNonce', {
  schema: schema,
  classMethods: { findByNonce: findByNonce }
}).publicModel;

module.exports = LtiNonce;
