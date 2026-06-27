// Map the LTI `roles` claim to trinket course roles (LTI-SPEC §8.4).
//   Instructor / TeachingAssistant / ContentDeveloper count as "teacher" roles.
var TEACHER_RE = /#(Instructor|TeachingAssistant|ContentDeveloper)$/;

function isTeacherRole(rolesClaim) {
  var roles = Array.isArray(rolesClaim) ? rolesClaim : (rolesClaim ? [rolesClaim] : []);
  return roles.some(function (r) { return TEACHER_RE.test(r); });
}

// Back-compat: pure LMS-claim → role (no instructor-authority intersection). The launch
// controller no longer calls this; it combines isTeacherRole with ltiInstructorAuthority.
function mapCourseRole(rolesClaim) {
  return isTeacherRole(rolesClaim) ? 'course-admin' : 'course-student';
}

module.exports = { isTeacherRole: isTeacherRole, mapCourseRole: mapCourseRole };
