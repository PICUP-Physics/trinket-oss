// Maps an LMS placement (resource_link_id within a platform) to a trinket target (LTI-SPEC §6,
// §10). v1 resolves the course via a custom param and persists the mapping here so later launches
// of the same link skip the param; Deep Linking would later write the same record.
var model = require('./model');

var schema = {
  platformId     : { type: String, required: true },
  resourceLinkId : { type: String, required: true },
  contextId      : { type: String },
  courseId       : { type: String },
  targetType     : { type: String },   // course | topic | page | assignment
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

// A material can carry SEVERAL assignment placements. The LMS mints a fresh
// resource_link_id every time an assignment is created, so an instructor who
// redoes the setup leaves a dead row behind — seen live on one course: a
// placement abandoned at 15:26 and the real one made at 15:32, with all 58
// student tokens under the later row and none under the earlier.
//
// This was a findOne with no ordering, so which row came back was Firestore's
// default document-name order. The live row happened to sort first, and that
// was the only reason the assignment worked: had the ids sorted the other way,
// the dead placement would have been chosen and every submitter on that
// assignment would have shown "nothing submitted". Choose the most recently
// touched row instead, so it no longer depends on how an id happens to sort.
//
// Ordering happens in memory rather than with an orderBy on purpose: three
// equality filters plus a sort would need a composite Firestore index, and a
// single material only ever has a handful of placements.
function placementStamp(link) {
  var t = link && (link.lastUpdated || link.created);
  var n = t ? new Date(t).getTime() : 0;
  return isFinite(n) ? n : 0;
}

function findAssignmentLink(courseId, materialId, cb) {
  var q = { courseId: courseId, targetId: materialId, targetType: 'assignment' };
  var p = Promise.resolve(this.model.find(q)).then(function (list) {
    return (list || []).slice().sort(function (a, b) {
      return placementStamp(b) - placementStamp(a);
    })[0] || null;
  });
  if (cb) { p.then(function (d) { cb(null, d); }, function (e) { cb(e); }); return; }
  return p;
}

var LtiResourceLink = model.create('LtiResourceLink', {
  schema: schema,
  classMethods: { findByLink: findByLink, findAssignmentLink: findAssignmentLink }
}).publicModel;

module.exports = LtiResourceLink;
