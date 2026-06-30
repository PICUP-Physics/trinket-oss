// Build LMS gradebook URLs so instructors can jump from trinket's assignment dashboard
// directly to their LMS to enter a grade. Two levels:
//   - Course-level: links to the course gradebook (works for all supported LMSs).
//   - Student-level: links to a per-student grade entry page (Canvas SpeedGrader, D2L user
//     grades). Falls back to the course gradebook when no per-student pattern is known.
//
// Known platforms use built-in patterns. Unknown platforms fall back to the issuer root
// (gets the instructor to the LMS at minimum) unless a custom pattern is stored on
// LtiPlatform.gradebookUrlPattern / gradebookStudentUrlPattern.
'use strict';

// Template variables:
//   {issuer}     = LtiPlatform.issuer (the LMS root URL)
//   {contextId}  = LtiResourceLink.contextId (LMS course/section/ou ID from the launch JWT)
//   {lineItemId} = last path segment of LtiResourceLink.agsLineItemUrl (Canvas assignment ID)
//   {sub}        = LtiUserIdentity.sub (LMS-native user ID)
var COURSE_PATTERNS = {
  canvas:       '{issuer}/courses/{contextId}/gradebook',
  desire2learn: '{issuer}/d2l/lms/grades/gradesHome.d2l?ou={contextId}',
  moodle:       '{issuer}/grade/report/grader/index.php?id={contextId}',
  sakai:        '{issuer}/portal/site/{contextId}/tool/grades',
  blackboard:   '{issuer}/ultra/courses/{contextId}/grades',
};

// Per-student patterns. For LMSs not listed here the course gradebook is used as fallback.
// Canvas SpeedGrader: assignment_id = the line item ID (same as Canvas's assignment ID).
// D2L: userId in this URL is the D2L internal user ID, which matches the LTI sub claim.
var STUDENT_PATTERNS = {
  canvas:       '{issuer}/courses/{contextId}/gradebook/speed_grader?assignment_id={lineItemId}&student_id={sub}',
  desire2learn: '{issuer}/d2l/lms/grades/userGradesHome.d2l?ou={contextId}&userId={sub}',
  moodle:       '{issuer}/grade/report/user/index.php?id={contextId}&userid={sub}',
};

function interpolate(pattern, vars) {
  return pattern.replace(/\{(\w+)\}/g, function(_, k) {
    return vars[k] !== undefined ? vars[k] : '';
  });
}

// Extract the last path segment from an AGS lineitem URL, which Canvas uses as the assignment ID.
function lineItemId(url) {
  if (!url) return '';
  var m = url.replace(/\/?$/, '').match(/\/([^/?]+)(\?.*)?$/);
  return m ? m[1] : '';
}

// Build the course-level gradebook URL. Returns the platform issuer as a last-resort fallback
// so there is always something to link to for any LMS.
function buildCourseUrl(platform, link) {
  var pattern = platform.gradebookUrlPattern ||
                COURSE_PATTERNS[(platform.productFamily || '').toLowerCase()];
  if (!pattern) return platform.issuer || null;
  return interpolate(pattern, { issuer: platform.issuer, contextId: link.contextId || '' });
}

// Build the per-student grade entry URL. Falls back to the course gradebook when no
// per-student pattern is known for this LMS type. Returns null when sub is absent.
function buildStudentUrl(platform, link, sub) {
  if (!sub) return buildCourseUrl(platform, link);
  var family  = (platform.productFamily || '').toLowerCase();
  var pattern = platform.gradebookStudentUrlPattern || STUDENT_PATTERNS[family];
  if (!pattern) return buildCourseUrl(platform, link);
  return interpolate(pattern, {
    issuer:     platform.issuer,
    contextId:  link.contextId  || '',
    lineItemId: lineItemId(link.agsLineItemUrl),
    sub:        sub
  });
}

// Human-readable LMS name for button labels ("Grade in Canvas", "Grade in Brightspace", …).
function lmsName(platform) {
  if (platform.name) return platform.name;
  var family = (platform.productFamily || '').toLowerCase();
  if (family === 'canvas')       return 'Canvas';
  if (family === 'desire2learn') return 'Brightspace';
  if (family === 'moodle')       return 'Moodle';
  if (family === 'sakai')        return 'Sakai';
  if (family === 'blackboard')   return 'Blackboard';
  return 'LMS';
}

module.exports = { buildCourseUrl: buildCourseUrl, buildStudentUrl: buildStudentUrl, lmsName: lmsName };
