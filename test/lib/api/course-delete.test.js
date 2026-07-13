// Issue #2 (MIAuthors/trinket-oss): "Delete a course does not work".
// Prod (firestore backend) returns 500 on DELETE /api/courses/{id} for real
// courses while the owner-only happy path passes. These tests exercise the
// data shapes a real course accumulates: enrolled members, members whose
// account no longer exists, and legacy/malformed users-array entries.
const flow = require('../../helpers/flow.cjs');

beforeEach(() => {
  flow.cookies = {};
});

// Create a member User doc directly (no login needed — we only need the
// course's users array + the member's roles to look production-like).
async function makeMember(n) {
  const member = new User({
    fullname : 'course member ' + n,
    username : 'coursemember' + n,
    email    : 'coursemember' + n + '@example.com',
    password : 'password'
  });
  await member.save();
  return member;
}

describe('DELETE /api/courses/{id} with real-world course shapes (issue #2)', () => {
  let courseId;

  beforeEach(async () => {
    await flow.switchUser('user');
    await flow.createCourse();
    courseId = flow.lastResponse.body.course.id;
  });

  it('deletes a course with an enrolled student', async () => {
    const course = await Course.findById(courseId);
    const member = await makeMember('a');
    await course.addUser(member, ['course-student']);

    await flow.deleteCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(200);

    await flow.getCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(404);

    // the member's course role was revoked
    const after = await User.findById(member.id);
    const stale = (after.roles || []).filter(r => r.context === 'course:' + courseId);
    expect(stale).toHaveLength(0);
  });

  it('deletes a course with several enrolled students', async () => {
    const course = await Course.findById(courseId);
    for (const n of ['b1', 'b2', 'b3']) {
      await course.addUser(await makeMember(n), ['course-student']);
    }

    await flow.deleteCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(200);

    await flow.getCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(404);
  });

  it('deletes a course whose member account was deleted', async () => {
    const course = await Course.findById(courseId);
    const member = await makeMember('c');
    await course.addUser(member, ['course-student']);
    await member.remove();

    await flow.deleteCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(200);

    await flow.getCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(404);
  });

  it('deletes a course with a malformed users entry (no userId)', async () => {
    // Legacy/imported data can leave a users entry without a userId.
    const course = await Course.findById(courseId);
    course.users.push({ username : 'ghost', displayName : 'Ghost', roles : ['course-student'] });
    course.markModified('users');
    await course.save();

    await flow.deleteCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(200);

    await flow.getCourse(courseId);
    expect(flow.lastResponse.statusCode).toBe(404);
  });
});
