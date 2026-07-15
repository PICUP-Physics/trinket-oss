// Single-use, expiring token that gates GET/POST /lti/register. The raw token travels in the
// registration URL the instructor hands to their LMS admin; only its sha256 is stored. Consumed
// (usedAt + platformId set) on a SUCCESSFUL registration POST. See LTI Dynamic Registration (SP2).
var crypto = require('crypto');
var model  = require('./model');

var schema = {
  tokenHash        : { type: String, required: true },  // sha256(raw token), hex
  label            : { type: String },                  // human label, e.g. "UIndy Canvas"
  initiatedByEmail : { type: String },                  // approved instructor who generated it
  expiresAt        : { type: Date,   required: true },
  usedAt           : { type: Date,   default: null },
  platformId       : { type: String, default: null }    // set when consumed
};

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function findByHash(tokenHash, cb) {
  return this.model.findOne({ tokenHash: tokenHash }, cb);
}

function isValid() {
  return this.usedAt == null && this.expiresAt instanceof Date && this.expiresAt.getTime() > Date.now();
}

var LtiRegistrationToken = model.create('LtiRegistrationToken', {
  schema: schema,
  classMethods: {
    hashToken: hashToken,
    findByHash: findByHash
  },
  objectMethods: {
    isValid: isValid
  },
  index: [
    [{ tokenHash: 1 }, { unique: true }]
  ],
  publicSpec: {
    id: true, label: true, initiatedByEmail: true, expiresAt: true, usedAt: true, platformId: true
  }
}).publicModel;

module.exports = LtiRegistrationToken;
