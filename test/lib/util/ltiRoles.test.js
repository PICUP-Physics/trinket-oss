// Which LMS role strings count as "teacher".
//
// This had no test at all, and the pattern only matched the LTI 1.3 URI form
// (`…/membership#Instructor`) because it required a '#' immediately before the
// role name. LTI 1.1 never sends that shape: Canvas sends a bare `Instructor`,
// or a urn with '/' separators. So on 1.1 EVERY instructor and TA was
// classified as a student and enrolled as course-student — which is why a
// co-instructor added to a Canvas course could not open a submission in
// SpeedGrader (canReview needs send-submission-feedback) and instead got a
// 403 rendered as "Something went wrong".
//
// Found live: an instructor showing as Role=Teacher in Canvas People was
// course-student in trinket. Affects every 1.1 deploy, WileyPLUS included.
const ltiRoles = require('../../../lib/util/ltiRoles');

describe('ltiRoles.isTeacherRole', () => {
  describe('LTI 1.1 forms — what Canvas actually sends', () => {
    const teacherForms = [
      ['Instructor', 'Canvas short form'],
      ['TeachingAssistant', 'Canvas TA short form'],
      ['ContentDeveloper', 'Canvas Designer short form'],
      ['urn:lti:role:ims/lis/Instructor', 'urn role form'],
      ['urn:lti:instrole:ims/lis/Instructor', 'urn instrole form'],
      ['urn:lti:role:ims/lis/TeachingAssistant', 'urn TA form'],
    ];
    teacherForms.forEach(([role, label]) => {
      it(`treats ${label} as a teacher`, () => {
        expect(ltiRoles.isTeacherRole([role]), role).toBe(true);
      });
    });

    it('finds the teacher role among several, as Canvas sends them', () => {
      expect(ltiRoles.isTeacherRole(['Instructor', 'urn:lti:instrole:ims/lis/Administrator'])).toBe(true);
    });
  });

  describe('LTI 1.3 forms keep working', () => {
    it('treats the membership URI as a teacher', () => {
      expect(ltiRoles.isTeacherRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'])).toBe(true);
    });
    it('treats the 1.3 TA URI as a teacher', () => {
      expect(ltiRoles.isTeacherRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant'])).toBe(true);
    });
  });

  describe('non-teachers stay non-teachers', () => {
    const studentForms = [
      'Learner',
      'Student',
      'urn:lti:role:ims/lis/Learner',
      'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
      'urn:lti:sysrole:ims/lis/SysAdmin',
      'urn:lti:instrole:ims/lis/Administrator',
      'Mentor',
    ];
    studentForms.forEach((role) => {
      it(`does not promote ${role}`, () => {
        expect(ltiRoles.isTeacherRole([role]), role).toBe(false);
      });
    });

    it('does not match a role that merely ENDS in the word', () => {
      // Guards the boundary: broadening the pattern must not turn these into teachers.
      expect(ltiRoles.isTeacherRole(['NonInstructor'])).toBe(false);
      expect(ltiRoles.isTeacherRole(['CoInstructor'])).toBe(false);
    });

    it('is empty-safe', () => {
      expect(ltiRoles.isTeacherRole([])).toBe(false);
      expect(ltiRoles.isTeacherRole(null)).toBe(false);
      expect(ltiRoles.isTeacherRole(undefined)).toBe(false);
    });

    it('accepts a bare string as well as an array', () => {
      expect(ltiRoles.isTeacherRole('Instructor')).toBe(true);
      expect(ltiRoles.isTeacherRole('Learner')).toBe(false);
    });
  });
});

describe('ltiRoles.shouldUpdateCourseRole — a launch promotes, it never demotes', () => {
  // Both launch paths used to write the computed role whenever it differed from
  // the stored one, in either direction. So a course-admin granted inside
  // trinket — the owner adding a TA through the roster UI, which sets
  // 'course-' + role — was silently demoted to course-student on that person's
  // next launch, and lost grading rights. On a deploy whose instructor
  // authority is an allowlist, that happens to anyone not on the list, however
  // deliberately the owner granted it.
  const should = ltiRoles.shouldUpdateCourseRole;

  it('enrolls someone who has no role yet', () => {
    expect(should(null, 'course-student')).toBe(true);
    expect(should(undefined, 'course-admin')).toBe(true);
  });

  it('promotes a student the LMS now calls a teacher', () => {
    expect(should('course-student', 'course-admin')).toBe(true);
  });

  it('does NOT demote an admin, however the role was granted', () => {
    expect(should('course-admin', 'course-student')).toBe(false);
  });

  it('never touches a course owner', () => {
    expect(should('course-owner', 'course-admin')).toBe(false);
    expect(should('course-owner', 'course-student')).toBe(false);
  });

  it('does nothing when the role already matches', () => {
    expect(should('course-admin', 'course-admin')).toBe(false);
    expect(should('course-student', 'course-student')).toBe(false);
  });
});
