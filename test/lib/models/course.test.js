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
