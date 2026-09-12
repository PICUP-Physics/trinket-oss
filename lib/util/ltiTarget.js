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
// Note this never inspects the material's TYPE — it just locates a material
// within the course and returns its coordinates. That is why a page (#13) can
// reuse it unchanged: an assignment and a page differ in whether they carry a
// line item, not in how they are addressed.
// Returns Promise<{ materialId, lessonSlug, materialSlug } | null>.
function resolveMaterial(course, materialId) {
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

// Map a trinket_topic lesson id to its course-page coordinates. A bare lesson
// fragment (#/{lessonSlug}) is NOT routable by the course SPA (its param routes
// are all two-segment /:lessonSlug/:materialSlug), so a topic launch is landed
// on the topic's FIRST material page (#/{lessonSlug}/{materialSlug}) — the same
// two-segment shape assignment launches use, which the SPA routes for both the
// instructor (courseEditor) and student (courseView) apps. Falls back to just
// the lessonSlug for an empty topic (no materials). Cached on the resource link.
// Returns Promise<{ lessonSlug, materialSlug? } | null>.
function resolveTopic(lessonId) {
  if (!lessonId) return Promise.resolve(null);
  return Promise.resolve(Lesson.findById(lessonId)).then(function(lesson) {
    if (!lesson || !lesson.slug) return null;
    var firstMaterialId = (lesson.materials || [])[0];
    if (!firstMaterialId) {
      return { lessonSlug: lesson.slug };
    }
    return Promise.resolve(Material.findById(firstMaterialId)).then(function(m) {
      return (m && m.slug)
        ? { lessonSlug: lesson.slug, materialSlug: m.slug }
        : { lessonSlug: lesson.slug };
    }, function() { return { lessonSlug: lesson.slug }; });
  }, function() { return null; });
}

// Write a re-resolved material's slugs back onto a pre-fix LtiResourceLink so the
// NEXT launch of that link takes the cached branch instead of repeating the lesson
// scan (one read per lesson + the material read) on every launch. Best-effort like
// the bootstrap persist: resolution succeeds whether or not the write does. Only
// writes when the resolve produced BOTH slugs — a missing material leaves the record
// untouched. The record already carries every other field bootstrap persists
// (platform/link/context/course/targetType/targetId; agsLineItemUrl is write-once on
// first launch), so after this it is identical to a freshly created one.
// Returns Promise<coords> (the input, unchanged).
function healSlugs(existing, coords) {
  if (!coords || !coords.lessonSlug || !coords.materialSlug) return Promise.resolve(coords);
  existing.lessonSlug   = coords.lessonSlug;
  existing.materialSlug = coords.materialSlug;
  function done() { return coords; }
  return Promise.resolve().then(function() { return existing.save(); }).then(done, done);
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
        if (targetType === 'topic') {
          // cached slugs → no scan; pre-fix records (lessonSlug but no materialSlug, from before
          // first-material landing existed) re-resolve best-effort so existing topic links start
          // landing on the topic's first page without recreating them in the LMS.
          if (existing.lessonSlug && existing.materialSlug) {
            return { course: course, targetType: 'topic', topic: { lessonSlug: existing.lessonSlug, materialSlug: existing.materialSlug } };
          }
          return resolveTopic(existing.targetId).then(function(topic) {
            return { course: course, targetType: 'topic', topic: topic || { lessonSlug: existing.lessonSlug } };
          });
        }
        if (targetType === 'page') {
          // Same shape as an assignment (a page is a material without a line item).
          // Records persisted before the page branch existed (#13) carry the targetId
          // but no slugs, so re-resolve those best-effort rather than recreating the link.
          if (existing.lessonSlug && existing.materialSlug) {
            return { course: course, targetType: 'page', page: {
              materialId: existing.targetId, lessonSlug: existing.lessonSlug, materialSlug: existing.materialSlug
            } };
          }
          return resolveMaterial(course, existing.targetId).then(function(page) {
            return healSlugs(existing, page);
          }).then(function(page) {
            return { course: course, targetType: 'page', page: page };
          });
        }
        if (targetType !== 'assignment') return { course: course, targetType: targetType };
        // cached slugs → no scan; older records (pre-cache) fall back to a best-effort re-resolve
        if (existing.lessonSlug && existing.materialSlug) {
          return { course: course, targetType: targetType, assignment: {
            materialId: existing.targetId, lessonSlug: existing.lessonSlug, materialSlug: existing.materialSlug
          } };
        }
        return resolveMaterial(course, existing.targetId).then(function(assignment) {
          return healSlugs(existing, assignment);
        }).then(function(assignment) {
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
      var topicId      = custom.trinket_topic;
      // A page link (#13) addresses a specific material that is NOT gradable.
      // Same coordinates as an assignment, no line item.
      var pageId       = custom.trinket_page;
      var endpoint     = claims[AGS + 'endpoint'] || {};
      var targetType   = assignmentId ? 'assignment'
                       : (pageId ? 'page' : (topicId ? 'topic' : 'course'));
      console.log('[ltiTarget] bootstrap', { targetType: targetType, assignmentId: assignmentId, lineitem: endpoint.lineitem || null, scope: endpoint.scope || null });
      var detailP;
      if (assignmentId)  detailP = resolveMaterial(course, assignmentId).then(function(a) { return { assignment: a }; });
      else if (pageId)   detailP = resolveMaterial(course, pageId).then(function(p) { return { page: p }; });
      else if (topicId)  detailP = resolveTopic(topicId).then(function(t) { return { topic: t }; });
      else               detailP = Promise.resolve({});
      return detailP.then(function(detail) {
        var assignment = detail.assignment, topic = detail.topic, page = detail.page;
        var rec = new LtiResourceLink({
          platformId: platform.id, resourceLinkId: resourceLinkId, contextId: ctx.id, courseId: course.id,
          targetType: targetType,
          targetId:   assignmentId ? String(assignmentId)
                    : (pageId ? String(pageId) : (topicId ? String(topicId) : course.id)),
          agsLineItemUrl: assignmentId ? endpoint.lineitem : undefined,
          lessonSlug:   assignment ? assignment.lessonSlug
                      : (page ? page.lessonSlug : (topic ? topic.lessonSlug : undefined)),
          materialSlug: assignment ? assignment.materialSlug
                      : (page ? page.materialSlug : (topic ? topic.materialSlug : undefined))
        });
        // best-effort persist; resolution still succeeds if the write fails
        return Promise.resolve(rec.save()).then(
          function() { return { course: course, targetType: targetType, assignment: assignment, topic: topic, page: page }; },
          function() { return { course: course, targetType: targetType, assignment: assignment, topic: topic, page: page }; }
        );
      });
    });
  });
}

module.exports = { resolveTarget: resolveTarget };
