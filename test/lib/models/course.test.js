const _       = require('underscore');
const ownable = require('../../../lib/models/plugins/ownable');

describe('Course model', () => {
  describe('plugins', () => {
    it('implements the ownable plugin', () => {
      const plugin = _.find(Course.plugins, (p) => Array.isArray(p) && p[0] === ownable);
      expect(plugin != null).toBe(true);
    });
  });

  describe('object methods', () => {
    // recordView issues a Mongo positional update ($set "users.$.lastView.viewedOn"
    // with an $elemMatch filter). On the firestore backend this crashed with
    // "At least one field must be updated" (empty resolved patch passed to
    // update()) and, when it did match, wrote a literal "lastView.viewedOn" key.
    describe('recordView', () => {
      let owner, course;

      beforeEach(async () => {
        owner = new User({ fullname: 'view owner', username: 'viewowner', email: 'viewowner@email.com', password: 'password' });
        await owner.save();
        course = new Course({ name: 'view course', _owner: owner, ownerSlug: owner.username });
        course.setOwner(owner);
        await course.save();
        await course.addUser(owner, ['course-owner']);
      });

      it('records the viewing time for a course member', async () => {
        await course.recordView(owner.id);
        const reloaded = await Course.findById(course.id);
        const entry = reloaded.users.find((u) => u.userId.toString() === owner.id.toString());
        expect(entry.lastView).toBeTruthy();
        expect(entry.lastView.viewedOn).toBeTruthy();
        expect(new Date(entry.lastView.viewedOn).getTime()).not.toBeNaN();
      });

      it('is a no-op, not an error, for a viewer who is not in the course', async () => {
        await expect(course.recordView('507f191e810c19729de860ea')).resolves.toBeDefined();
        const reloaded = await Course.findById(course.id);
        expect(reloaded.users).toHaveLength(1);
        expect(reloaded.users[0].lastView && reloaded.users[0].lastView.viewedOn).toBeFalsy();
      });
    });

    describe('copy', () => {
      it('copies the course fields', async () => {
        const owner = new User({ fullname: 'test course owner', username: 'testcourseowner', email: 'testcourseowner@email.com', password: 'password' });
        const user  = new User({ fullname: 'test user', username: 'testuser', email: 'testuser@email.com', password: 'password' });
        const material = new Material({ name: 'material name', content: 'material content', _owner: owner });
        await material.save();
        const lesson = new Lesson({ name: 'lesson name', _owner: owner, materials: [material.id] });
        await lesson.save();
        const course = new Course({ name: 'course name', description: 'course description', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
        await course.save();

        const copy = await new Promise((resolve, reject) => course.copy(user, (err, c) => err ? reject(err) : resolve(c)));
        expect(copy).toHaveProperty('name', course.name);
        expect(copy).toHaveProperty('description', course.description);
        expect(copy).toHaveProperty('lessons');
      });
    });
  });
});
