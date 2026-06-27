// Resolve a launch to its trinket target (LTI-SPEC §6): a persisted LtiResourceLink mapping,
// else the `trinket_course` (+ optional `trinket_assignment`) custom parameters, else nothing.
// The course is the enrollment unit; when the launch targets an assignment we also resolve the
// assignment's course-page coordinates (lessonSlug + materialSlug) so the handler can land the
// user on the authored assignment page (instructions + embedded trinket) at
// /{ownerSlug}/courses/{slug}#/{lessonSlug}/{materialSlug} instead of the bare course.
// Returns Promise<{ course, targetType, assignment? } | { course: null }>.
var Course          = require('../models/course');
var Lesson          = require('../models/lesson');
var Material        = require('../models/material');
var LtiResourceLink = require('../models/ltiResourceLink');

// Map a trinket_assignment material id to its course-page coordinates: find the lesson that
// contains it (scan the course's lessons, short-circuiting on the hit) and read both slugs.
// Runs at most once per resource link — the slugs are cached on the LtiResourceLink afterwards,
// so steady-state launches never re-scan (CLAUDE.md Firestore-cost rule).
// Returns Promise<{ materialId, lessonSlug, materialSlug } | null>.
function resolveAssignment(course, materialId) {
  if (!course || !materialId) return Promise.resolve(null);
  var mid = String(materialId);
  var lessonIds = (course.lessons || []).map(String);
  function findLesson(i) {
    if (i >= lessonIds.length) return Promise.resolve(null);
    return Promise.resolve(Lesson.findById(lessonIds[i])).then(function(lesson) {
      var has = lesson && (lesson.materials || []).map(String).indexOf(mid) >= 0;
      return has ? lesson : findLesson(i + 1);
    }, function() { return findLesson(i + 1); });
  }
  return findLesson(0).then(function(lesson) {
    if (!lesson || !lesson.slug) return null;
    return Promise.resolve(Material.findById(materialId)).then(function(m) {
      return (m && m.slug)
        ? { materialId: mid, lessonSlug: lesson.slug, materialSlug: m.slug }
        : null;
    }, function() { return null; });
  });
}

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
var AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/';

function resolveTarget(claims, platform) {
  var rl     = claims[LTI + 'resource_link'] || {};
  var ctx    = claims[LTI + 'context'] || {};
  var custom = claims[LTI + 'custom'] || {};
  var resourceLinkId = rl.id;

  return Promise.resolve(LtiResourceLink.findByLink(platform.id, resourceLinkId)).then(function(existing) {
    // 1. previously-resolved mapping
    if (existing && existing.courseId) {
      return Promise.resolve(Course.findById(existing.courseId)).then(function(course) {
        if (!course) return { course: null };
        var targetType = existing.targetType || 'course';
        if (targetType !== 'assignment') return { course: course, targetType: targetType };
        // cached slugs → no scan; older records (pre-cache) fall back to a best-effort re-resolve
        if (existing.lessonSlug && existing.materialSlug) {
          return { course: course, targetType: targetType, assignment: {
            materialId: existing.targetId, lessonSlug: existing.lessonSlug, materialSlug: existing.materialSlug
          } };
        }
        return resolveAssignment(course, existing.targetId).then(function(assignment) {
          return { course: course, targetType: targetType, assignment: assignment };
        });
      });
    }
    // 2. bootstrap from the custom param, then persist (incl. the resolved slugs)
    var courseId = custom.trinket_course;
    if (!courseId) return { course: null };
    return Promise.resolve(Course.findById(courseId)).then(function(course) {
      if (!course) return { course: null };
      var assignmentId = custom.trinket_assignment;
      var endpoint     = claims[AGS + 'endpoint'] || {};
      var targetType   = assignmentId ? 'assignment' : 'course';
      var assignmentP  = assignmentId ? resolveAssignment(course, assignmentId) : Promise.resolve(null);
      return assignmentP.then(function(assignment) {
        var rec = new LtiResourceLink({
          platformId: platform.id, resourceLinkId: resourceLinkId, contextId: ctx.id, courseId: course.id,
          targetType: targetType,
          targetId:   assignmentId ? String(assignmentId) : course.id,
          agsLineItemUrl: assignmentId ? endpoint.lineitem : undefined,
          lessonSlug:   assignment ? assignment.lessonSlug : undefined,
          materialSlug: assignment ? assignment.materialSlug : undefined
        });
        // best-effort persist; resolution still succeeds if the write fails
        return Promise.resolve(rec.save()).then(
          function() { return { course: course, targetType: targetType, assignment: assignment }; },
          function() { return { course: course, targetType: targetType, assignment: assignment }; }
        );
      });
    });
  });
}

module.exports = { resolveTarget: resolveTarget };
