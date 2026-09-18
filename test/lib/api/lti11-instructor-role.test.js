// What course role a real LTI 1.1 launch actually produces.
//
// This is the assertion that was missing. The 1.1 launch tests already passed
// roles: 'Instructor' — the true Canvas form — but none of them ever checked
// the role the launch assigned, so a mapping that classified every 1.1
// instructor as a student sailed through a green suite. Found live: an
// instructor listed as Role=Teacher in Canvas People was course-student in
// trinket and got a 403 ("Something went wrong") opening a submission in
// SpeedGrader.
//
// Under the default instructor-authority (trust the platform, which is what the
// test profile uses) isInstructor tracks lmsTeacher, so the role the launch
// writes is a direct read-out of isTeacherRole through the whole launch path.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const User     = require('../../../lib/models/user');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const LAUNCH = '/lti11/launch';
const serverUrl = (path) => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path },
  config.app.url, publicHostname.resolve);

function signedLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-role-1',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'ro-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(LAUNCH), p, consumer.secret);
  return p;
}

async function seedConsumer() {
  const c = new LtiConsumer({
    key: 'ro-' + Math.random().toString(36).slice(2, 10),
    secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'role test'
  });
  await c.save();
  return c;
}

// Enrollment is awaited inside the launch, but read back defensively.
async function roleInCourse(email, courseId) {
  for (let i = 0; i < 40; i++) {
    const u = await User.findByLogin(email);
    const ctx = u && u.getByContext && u.getByContext('course:' + courseId);
    const role = ctx && ctx.roles && ctx.roles[0];
    if (role) return role;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

describe('LTI 1.1 launch → trinket course role', () => {
  beforeEach(() => { flow.cookies = {}; });

  async function launchAs(roles, email) {
    const consumer = await seedConsumer();
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Role Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;
    flow.cookies = {};

    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      user_id: 'u-' + Math.random().toString(36).slice(2, 8),
      roles: roles,
      lis_person_contact_email_primary: email,
      lis_person_name_full: 'Role Test',
      custom_trinket_course: course.id
    }));
    expect(flow.lastResponse.statusCode).toBe(302);
    return { course, role: await roleInCourse(email, course.id) };
  }

  it("enrolls Canvas's bare Instructor as course-admin", async () => {
    const { role } = await launchAs('Instructor', 'role-instructor@example.com');
    expect(role, 'a Canvas Teacher must be able to grade').toBe('course-admin');
  });

  it('enrolls the urn Instructor form as course-admin', async () => {
    const { role } = await launchAs('urn:lti:role:ims/lis/Instructor', 'role-urn@example.com');
    expect(role).toBe('course-admin');
  });

  it('enrolls a TeachingAssistant as course-admin', async () => {
    const { role } = await launchAs('TeachingAssistant', 'role-ta@example.com');
    expect(role).toBe('course-admin');
  });

  it('still enrolls a Learner as course-student', async () => {
    const { role } = await launchAs('Learner', 'role-learner@example.com');
    expect(role).toBe('course-student');
  });

  it('does not demote an admin granted inside trinket', async () => {
    // The owner adds a TA through the roster UI. That person is not an LMS
    // teacher — and on an allowlist deploy would not be an instructor either —
    // so the launch computes course-student. It must leave the grant alone.
    const consumer = await seedConsumer();
    const email = 'role-granted-admin@example.com';
    const userId = 'u-granted-1';
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Granted Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;

    // First launch as a plain student, to create the user and enrol them.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      user_id: userId, roles: 'Learner',
      lis_person_contact_email_primary: email, lis_person_name_full: 'Granted Admin',
      custom_trinket_course: course.id
    }));
    expect(await roleInCourse(email, course.id)).toBe('course-student');

    // The owner grants admin in trinket.
    const Course = require('../../../lib/models/course');
    const granted = await User.findByLogin(email);
    const courseDoc = await Course.findById(course.id);
    await courseDoc.updateRole(granted, 'course-admin');
    expect(await roleInCourse(email, course.id)).toBe('course-admin');

    // They launch again, still a Learner as far as the LMS is concerned.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      user_id: userId, roles: 'Learner',
      lis_person_contact_email_primary: email, lis_person_name_full: 'Granted Admin',
      custom_trinket_course: course.id
    }));
    expect(flow.lastResponse.statusCode).toBe(302);

    expect(await roleInCourse(email, course.id),
      'a launch must not take away a role the owner granted').toBe('course-admin');
  });

  it('promotes on a LATER launch once the LMS reports the teacher role', async () => {
    // The real sequence: someone launches as a student, is added as a teacher
    // in the LMS, and launches again. The second launch must update the role,
    // not leave them stuck as a student.
    const consumer = await seedConsumer();
    const email = 'role-promoted@example.com';
    const userId = 'u-promote-1';
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Promote Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;

    for (const roles of ['Learner', 'Instructor']) {
      flow.cookies = {};
      await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
        user_id: userId, roles: roles,
        lis_person_contact_email_primary: email,
        lis_person_name_full: 'Promote Test',
        custom_trinket_course: course.id
      }));
      expect(flow.lastResponse.statusCode).toBe(302);
    }

    expect(await roleInCourse(email, course.id)).toBe('course-admin');
  });
});
