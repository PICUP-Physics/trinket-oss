// Resolve a launch to its trinket target course (LTI-SPEC §6). v1: a persisted LtiResourceLink
// mapping, else the `trinket_course` custom parameter (a trinket course id), else nothing. The
// course is the enrollment unit; topic/assignment landing precision is a later refinement.
// Returns Promise<{ course, targetType } | { course: null }>.
var Course          = require('../models/course');
var LtiResourceLink = require('../models/ltiResourceLink');

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';

function resolveTarget(claims, platform) {
  var rl     = claims[LTI + 'resource_link'] || {};
  var ctx    = claims[LTI + 'context'] || {};
  var custom = claims[LTI + 'custom'] || {};
  var resourceLinkId = rl.id;

  return Promise.resolve(LtiResourceLink.findByLink(platform.id, resourceLinkId)).then(function(existing) {
    // 1. previously-resolved mapping
    if (existing && existing.courseId) {
      return Promise.resolve(Course.findById(existing.courseId)).then(function(course) {
        return course ? { course: course, targetType: existing.targetType || 'course' } : { course: null };
      });
    }
    // 2. bootstrap from the custom param, then persist
    var courseId = custom.trinket_course;
    if (!courseId) return { course: null };
    return Promise.resolve(Course.findById(courseId)).then(function(course) {
      if (!course) return { course: null };
      var rec = new LtiResourceLink({
        platformId: platform.id, resourceLinkId: resourceLinkId, contextId: ctx.id,
        courseId: course.id, targetType: 'course', targetId: course.id
      });
      // best-effort persist; resolution still succeeds if the write fails
      return Promise.resolve(rec.save()).then(
        function() { return { course: course, targetType: 'course' }; },
        function() { return { course: course, targetType: 'course' }; }
      );
    });
  });
}

module.exports = { resolveTarget: resolveTarget };
