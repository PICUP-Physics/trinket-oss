// Links an LTI platform user (iss + stable sub) to a trinket User (LTI-SPEC §8.1). The durable
// identity is (iss, sub) — NOT email (LTI email is optional/mutable). One trinket user may have
// several identities (different platforms). email/name are cached from the launch for reference.
var model = require('./model');

var schema = {
  iss    : { type: String, required: true },
  sub    : { type: String, required: true },
  userId : { type: String, required: true },   // trinket User id (string id works on both backends)
  email  : { type: String },
  name   : { type: String }
};

function findByIssSub(iss, sub, cb) {
  return this.model.findOne({ iss: iss, sub: sub }, cb);
}

function findByUserAndIss(userId, iss, cb) {
  return this.model.findOne({ userId: userId, iss: iss }, cb);
}

// Batch: find all identity records for a set of trinket userIds on one platform (one query,
// not N). Used by the assignment dashboard to build per-student LMS grade-entry links.
function findByUsersAndIss(userIds, iss, cb) {
  if (!userIds || !userIds.length) {
    var empty = [];
    return cb ? (cb(null, empty), undefined) : Promise.resolve(empty);
  }
  return this.model.find({ iss: iss, userId: { $in: userIds } }, cb);
}

var LtiUserIdentity = model.create('LtiUserIdentity', {
  schema: schema,
  classMethods: { findByIssSub: findByIssSub, findByUserAndIss: findByUserAndIss, findByUsersAndIss: findByUsersAndIss }
}).publicModel;

module.exports = LtiUserIdentity;
