// Map the LTI `roles` claim to trinket course roles (LTI-SPEC §8.4).
//   Instructor / TeachingAssistant / ContentDeveloper count as "teacher" roles.
//
// The role name may arrive bare or behind any of the separators the two LTI
// versions use, so match on the name at the END of the string preceded by
// start-of-string, '#', '/' or ':':
//
//   Instructor                                              1.1, Canvas short form
//   urn:lti:role:ims/lis/Instructor                         1.1, urn form
//   urn:lti:instrole:ims/lis/Instructor                     1.1, urn instrole form
//   http://purl.imsglobal.org/…/membership#Instructor       1.3
//
// This used to require a '#' immediately before the name, which ONLY the 1.3
// URI form has. LTI 1.1 never sends that shape, so every 1.1 instructor and TA
// was classified as a student and enrolled course-student — which left a real
// co-instructor unable to open a submission in SpeedGrader (canReview needs
// send-submission-feedback) and looking at a 403 rendered as "Something went
// wrong". It went unnoticed because nothing asserted the mapping: the 1.1
// launch tests passed roles: 'Instructor' and never checked what came out.
//
// The boundary matters — 'NonInstructor' and the like must NOT promote.
//
// Note this is only half the decision: the launch intersects isTeacherRole with
// ltiInstructorAuthority.resolveInstructor, so a platform asserting Instructor
// for someone who is not a known instructor still does not get course-admin.
var TEACHER_RE = /(?:^|[#\/:])(Instructor|TeachingAssistant|ContentDeveloper)$/;

function isTeacherRole(rolesClaim) {
  var roles = Array.isArray(rolesClaim) ? rolesClaim : (rolesClaim ? [rolesClaim] : []);
  return roles.some(function (r) { return TEACHER_RE.test(r); });
}

// Back-compat: pure LMS-claim → role (no instructor-authority intersection). The launch
// controller no longer calls this; it combines isTeacherRole with ltiInstructorAuthority.
function mapCourseRole(rolesClaim) {
  return isTeacherRole(rolesClaim) ? 'course-admin' : 'course-student';
}

// May a launch move this user's course role, given what it computed?
//
// Promote yes, demote never. Both launch paths used to write the computed role
// whenever it differed from the stored one, in EITHER direction — so a
// course-admin granted inside trinket (the owner adding a TA through the
// roster UI, which POSTs 'course-' + role) was silently taken away on that
// person's next launch, and they lost grading rights. On a deploy whose
// instructor authority is an allowlist that happens to anyone not on the list,
// however deliberately the owner granted it. The LMS is one authority over who
// may grade; the course owner is another, and a launch must not overrule them.
//
// What this gives up: someone genuinely demoted from teacher to student in the
// LMS keeps course-admin until the owner removes it. That costs little in
// practice — the old behaviour only ever demoted people who were still
// launching, and anyone removed from the LMS course stops launching and was
// never demoted either. Distinguishing an LTI-granted role from a hand-granted
// one would need provenance on the role itself.
//
// Shared by both launch paths deliberately: this is exactly the kind of
// decision that drifts when 1.1 and 1.3 each keep their own copy.
function shouldUpdateCourseRole(currentRole, computedRole) {
  if (!currentRole) return true;                     // not enrolled yet
  if (currentRole === computedRole) return false;    // nothing to do
  if (currentRole === 'course-owner') return false;  // never touch an owner
  return computedRole === 'course-admin';            // promote only
}

module.exports = { isTeacherRole: isTeacherRole, mapCourseRole: mapCourseRole,
                   shouldUpdateCourseRole: shouldUpdateCourseRole };
