// Maps an LMS placement (resource_link_id within a platform) to a trinket target (LTI-SPEC §6,
// §10). v1 resolves the course via a custom param and persists the mapping here so later launches
// of the same link skip the param; Deep Linking would later write the same record.
var model = require('./model');

var schema = {
  platformId     : { type: String, required: true },
  resourceLinkId : { type: String, required: true },
  contextId      : { type: String },
  courseId       : { type: String },
  targetType     : { type: String },   // course | topic | assignment
  targetId       : { type: String }
};

function findByLink(platformId, resourceLinkId, cb) {
  return this.model.findOne({ platformId: platformId, resourceLinkId: resourceLinkId }, cb);
}

var LtiResourceLink = model.create('LtiResourceLink', {
  schema: schema,
  classMethods: { findByLink: findByLink }
}).publicModel;

module.exports = LtiResourceLink;
