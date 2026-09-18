'use strict';

// The roster carries the name parts, not just the display name.
//
// The dashboards sort the DENORMALIZED roster entries, not user documents, so
// a surname stored on the user is invisible to them unless it is copied across
// like displayName already is. Without this the sort would keep guessing even
// for users whose surname we know.
const Course = require('../../../lib/models/course');
const User   = require('../../../lib/models/user');

const uniq = () => Math.random().toString(36).slice(2, 10);

async function makeUser(extra) {
  const id = uniq();
  const u = new User(Object.assign({
    fullname: 'Ana de la Cruz',
    username: 'roster-' + id,
    email: 'roster-' + id + '@example.com',
    password: 'flim-flam-bim-bam'
  }, extra || {}));
  await u.save();
  return u;
}

async function makeCourse(owner) {
  const c = new Course({
    name: 'Roster Course ' + uniq(), description: 'x',
    _owner: owner, ownerSlug: owner.username
  });
  await c.save();
  return c;
}

function entryFor(course, user) {
  return (course.users || []).filter((e) => String(e.userId) === String(user.id))[0];
}

describe('course roster carries the name parts', () => {
  it('copies given and family name across when a user is added', async () => {
    const owner = await makeUser();
    const student = await makeUser({ givenName: 'Ana', familyName: 'de la Cruz' });
    const course = await makeCourse(owner);

    await course.addUser(student, ['course-student']);
    const fresh = await Course.findById(course.id);
    const entry = entryFor(fresh, student);

    expect(entry, 'the student should be on the roster').toBeTruthy();
    expect(entry.displayName).toBe('Ana de la Cruz');
    expect(entry.familyName).toBe('de la Cruz');
    expect(entry.givenName).toBe('Ana');
  });

  it('leaves them unset for a user we have no parts for', async () => {
    const owner = await makeUser();
    const student = await makeUser();
    const course = await makeCourse(owner);

    await course.addUser(student, ['course-student']);
    const fresh = await Course.findById(course.id);
    const entry = entryFor(fresh, student);

    expect(entry.displayName).toBe('Ana de la Cruz');
    expect(entry.familyName, 'nothing to copy, so nothing is copied').toBeFalsy();
  });
});
