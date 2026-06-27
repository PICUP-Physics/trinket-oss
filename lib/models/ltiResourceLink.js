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
  targetId       : { type: String },
  agsLineItemUrl : { type: String },   // AGS line-item endpoint, captured write-once on first launch
  // Deep-link landing coords, resolved + cached on first launch so subsequent launches skip the
  // Course->Lesson scan: the assignment lives at /{ownerSlug}/courses/{slug}#/{lessonSlug}/{materialSlug}.
  lessonSlug     : { type: String },
  materialSlug   : { type: String }
};

function findByLink(platformId, resourceLinkId, cb) {
  return this.model.findOne({ platformId: platformId, resourceLinkId: resourceLinkId }, cb);
}

function findAssignmentLink(courseId, materialId, cb) {
  return this.model.findOne(
    { courseId: courseId, targetId: materialId, targetType: 'assignment' }, cb);
}

var LtiResourceLink = model.create('LtiResourceLink', {
  schema: schema,
  classMethods: { findByLink: findByLink, findAssignmentLink: findAssignmentLink }
}).publicModel;

module.exports = LtiResourceLink;
