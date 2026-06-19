// Map the LTI `roles` claim to a trinket course role (LTI-SPEC §8.4; decided 2026-06-19).
//   Instructor / TeachingAssistant / ContentDeveloper -> course-admin
//       (manage content + assignments, view submissions, send feedback; NOT delete/ownership)
//   everything else, incl. Learner / unknown          -> course-student (view only, least privilege)
var TEACHER_RE = /#(Instructor|TeachingAssistant|ContentDeveloper)$/;

function mapCourseRole(rolesClaim) {
  var roles = Array.isArray(rolesClaim) ? rolesClaim : (rolesClaim ? [rolesClaim] : []);
  return roles.some(function(r) { return TEACHER_RE.test(r); }) ? 'course-admin' : 'course-student';
}

module.exports = { mapCourseRole: mapCourseRole };
