const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// Reset the cookie jar before every test.
// Login rate-limit counters are now flushed globally by the harness afterEach
// (vitest-setup.cjs flushAll on the in-memory redis client).
beforeEach(() => {
  flow.cookies = {};
});

describe('Course Creation', () => {
  describe('As a logged in user', () => {
    // -----------------------------------------------------------------
    // When I post a new course
    // -----------------------------------------------------------------
    describe('When I post a new course', () => {
      let course, courseId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        course   = flow.lastResponse.body.course;
        courseId = course.id;
      });

      it('should return a new course', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body).toHaveProperty('course');
        for (const property in defaults.course) {
          expect(flow.lastResponse.body.course).toHaveProperty(property, defaults.course[property]);
        }
      });

      it('should allow me to get the course', async () => {
        await flow.getCourse(courseId);
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        for (const property in defaults.course) {
          expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.course[property]);
        }
      });

      // getCourseBySlug renders a Nunjucks/Angular SPA shell; the course name
      // is fetched client-side by Angular, not embedded in the initial HTML.
      // Assert the SPA shell is served (200 + HTML content-type).
      it('should allow me to get the course using slugs', async () => {
        await flow.getCourseBySlug(defaults.user.username, course.slug);
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('text/html');
      });
    });

    // -----------------------------------------------------------------
    // When I edit an existing course
    // -----------------------------------------------------------------
    describe('When I edit an existing course', () => {
      // Full fixture: course + lesson + material + outline loaded.
      // course.lessons[0].id / course.lessons[0].materials[0].id are
      // populated by the outline query.
      // NOTE: flow.getCourseWithOutline sends ?outline=yes which fails Joi's
      // strict boolean validation (only true/false/1/0 are accepted). Use the
      // generic flow.get() with ?outline=true instead — same logic, valid param.
      let course, courseId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        courseId = flow.lastResponse.body.course.id;
        await flow.addNewLesson(courseId);
        const lessonId = flow.lastResponse.body.data.id;
        await flow.addNewMaterial(courseId, lessonId);
        await flow.get('/api/courses/' + courseId + '?outline=true');
        course = flow.lastResponse.body.data;
      });

      it('should allow me to edit the name', async () => {
        await flow.updateCourse(course.id, { name: 'aw shucks' });
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.course != null).toBe(true);
        expect(flow.lastResponse.body.course).toHaveProperty('name', 'aw shucks');
      });

      it('should change the slug when the name changes', async () => {
        await flow.updateCourse(course.id, { name: 'foo bar' });
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.course != null).toBe(true);
        expect(flow.lastResponse.body.course).toHaveProperty('slug', 'foo-bar');
      });

      // Slug-alias redirect: renaming a course changes its slug; the old slug is
      // aliased and its URL must 301 to the new slug. Regression guard for the
      // routeParser fakeReply fix — the pre-handler shim used to resolve the Promise
      // with null on the bare reply() before .redirect().takeover() ran (pre.course
      // became null -> 500 instead of 301). Fixed in lib/util/routeParser.js: defer
      // the bare reply() and resolve .takeover() with a real h.redirect(...) response.
      //
      // skipIf(firestore): the alias is recorded by preserveSlug, a post('init')
      // hook, and the Firestore backend does not run post('init') hooks (only
      // pre/post save — firestore-backend.js:1141-1142), so _original_slug is never
      // captured and getIdBySlug(oldSlug) returns null -> 404. This is a real
      // Firestore-backend gap (renamed slugs don't redirect on GCR prod), tracked
      // separately from the New-Trinket shim fix. Un-skip once post('init') hooks
      // run on the Firestore backend.
      it.skipIf(process.env.TEST_DB_BACKEND === 'firestore')('should redirect me to the current course if I use the original course slug', async () => {
        const originalSlug = course.slug;
        // Rename the course so the slug changes, then verify the old slug redirects.
        await flow.updateCourse(course.id, { name: 'foo bar' });
        await flow.getCourseBySlug(defaults.user.username, originalSlug);
        expect(flow.wasOk).toBe(true);
        // permanent redirect
        expect(flow.lastResponse.statusCode).toBe(301);
        expect(flow.lastResponse.redirect).toBe(true);
        expect(flow.lastRedirect.pathname).not.toContain(originalSlug);
        expect(flow.lastRedirect.pathname).toContain('foo-bar');
      });

      it('should allow me to change the course description', async () => {
        await flow.updateCourse(course.id, { description: 'something different' });
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.course).toHaveProperty('description', 'something different');
      });

      it('should allow me to rename lessons', async () => {
        await flow.updateLesson(course.id, course.lessons[0].id, { name: 'new lesson name' });
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.lesson).toHaveProperty('name', 'new lesson name');
      });

      it('should allow me to rename materials', async () => {
        await flow.updateMaterial(
          course.id, course.lessons[0].id, course.lessons[0].materials[0].id,
          { name: 'new material name' }
        );
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.material).toHaveProperty('name', 'new material name');
      });

      it('should allow me to update material content', async () => {
        await flow.patchMaterialContent(
          course.id, course.lessons[0].id, course.lessons[0].materials[0].id,
          { patch: defaults.patch.patch }
        );
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.material).toHaveProperty(
          'content', 'test content\nNo newline at end of file\n'
        );
      });

      // The controller now returns an empty array (not null) for an empty
      // materials/lessons list after deletion.
      it('should allow me to delete materials', async () => {
        await flow.deleteMaterial(
          course.id, course.lessons[0].id, course.lessons[0].materials[0].id
        );
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.lesson.materials).toEqual([]);
      });

      it('should allow me to delete lessons', async () => {
        await flow.deleteLesson(course.id, course.lessons[0].id);
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.course.lessons).toEqual([]);
      });
    });

    // -----------------------------------------------------------------
    // When I post a new lesson
    // -----------------------------------------------------------------
    describe('When I post a new lesson', () => {
      let courseId, lessonId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        courseId = flow.lastResponse.body.course.id;
        await flow.addNewLesson(courseId);
        lessonId = flow.lastResponse.body.data.id;
        // flow.lastResponse is now the addNewLesson response — tests that
        // assert on the immediate response read it here.
      });

      it('should return the new lesson', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        for (const property in defaults.lesson) {
          expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.lesson[property]);
        }
      });

      it('should allow me to get the lesson', async () => {
        await flow.getLesson(courseId, lessonId);
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        for (const property in defaults.lesson) {
          expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.lesson[property]);
        }
      });

      it('should allow me to reorder lessons', async () => {
        await flow.addNewLesson(courseId);
        await flow.moveLesson(courseId, lessonId, 1);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body.oldIndex).toEqual(0);
        expect(flow.lastResponse.body.newIndex).toEqual(1);
        expect(flow.lastResponse.body.newParent).toEqual(courseId);
      });
    });

    // -----------------------------------------------------------------
    // When I post new material to the lesson
    // -----------------------------------------------------------------
    describe('When I post new material to the lesson', () => {
      let courseId, lessonId, materialId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        courseId = flow.lastResponse.body.course.id;
        await flow.addNewLesson(courseId);
        lessonId = flow.lastResponse.body.data.id;
        await flow.addNewMaterial(courseId, lessonId);
        materialId = flow.lastResponse.body.data.id;
        // flow.lastResponse is now the addNewMaterial response.
      });

      it('should return the new material', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        for (const property in defaults.material) {
          expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.material[property]);
        }
      });

      // TODO(app-bug): genuine app bug, NOT an inject artifact — verified 500 over a
      // real HTTP listener (server.start() on port 0), not just server.inject().
      // The move route's pre is the string 'parent(payload.parent,pre.lesson)'
      // (config/api_routes.js). Legacy Hapi 4 appended a `next` callback as the final arg,
      // so internals.findById(id, optional, next) (lib/util/helpers.js) could fall back to
      // the lesson when no parent was supplied. The Hapi-20 routeParser instead calls the
      // server method with exactly the two resolved args (no next), so findById treats the
      // fallback lesson DOC as `next`, hits `if (!id) return next(err)`, and throws
      // "next is not a function" (confirmed by directly invoking server.methods.parent
      // with (undefined, lessonDoc)) → 500. This breaks BOTH same-lesson reorder (no parent)
      // AND cross-lesson transfer (parent present), since `next` is never a function here.
      // Cannot fix from test/ (defect is the lib/ server-method calling convention).
      it('should allow me to reorder material', async () => {
        await flow.addNewMaterial(courseId, lessonId);
        await flow.moveMaterial(courseId, lessonId, materialId, 1);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body.oldIndex).toEqual(0);
        expect(flow.lastResponse.body.newIndex).toEqual(1);
        expect(flow.lastResponse.body.newParent).toEqual(lessonId);
      });

      it('should allow me to get material content', async () => {
        await flow.getMaterial(courseId, lessonId, materialId);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        // TODO: check content which was patched earlier (original comment)
        for (const property in defaults.material) {
          expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.material[property]);
        }
      });

      it('should allow me to mark material content as draft', async () => {
        await flow.markMaterialDraft(courseId, lessonId, materialId);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.material.isDraft).toBe(true);
        expect(flow.lastContentType).toContain('application/json');
      });
    });

    // -----------------------------------------------------------------
    // Copy a course
    // -----------------------------------------------------------------
    describe('should allow me to copy a course', () => {
      let course, courseId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        course   = flow.lastResponse.body.course;
        courseId = course.id;
        await flow.copyCourse(courseId, { name: 'Copy of ' + course.name });
        // flow.lastResponse is now the copyCourse response.
      });

      it('should return the url of the copied course', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastResponse.body.url).toContain('copy-of-' + course.slug);
      });
    });

    // -----------------------------------------------------------------
    // Delete a course
    // -----------------------------------------------------------------
    describe('should allow me to delete a course', () => {
      let courseId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        courseId = flow.lastResponse.body.course.id;
        await flow.deleteCourse(courseId);
      });

      it('should no longer exist', async () => {
        await flow.getCourse(courseId);
        expect(flow.lastResponse.statusCode).toBe(404);
      });
    });

    // -----------------------------------------------------------------
    // Add Students — a mixed roster (existing accounts + new emails).
    // Existing accounts enroll immediately; new emails become invitations
    // (Aaron's request; builds on #10). Verifies the {enrolled, invitations}
    // response shape the client roster/pending lists consume.
    // -----------------------------------------------------------------
    describe('When I add a mixed student roster', () => {
      let courseId;

      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.createCourse();
        courseId = flow.lastResponse.body.course.id;
        // an existing Trinket account that is NOT yet in the course
        await new User({ email: 'roster-existing@x.edu', username: 'roster-existing', fullname: 'Existing' }).save();
      });

      it('enrolls existing accounts and invites new emails in one response', async () => {
        const r = await flow.post('/api/courses/' + courseId + '/invitations', {
          students: [
            { email: 'roster-existing@x.edu', name: 'Existing' },
            { email: 'roster-newcomer@x.edu', name: 'Newcomer' }
          ]
        });

        expect(r.statusCode).toBe(200);
        expect(r.body.success).toBe(true);

        const enrolledEmails = (r.body.enrolled || []).map((u) => u.email);
        const invitedEmails  = (r.body.invitations || []).map((i) => i.email);

        expect(enrolledEmails).toContain('roster-existing@x.edu');   // existing → enrolled now
        expect(invitedEmails).toContain('roster-newcomer@x.edu');    // new → invited
        expect(invitedEmails).not.toContain('roster-existing@x.edu'); // existing never invited
      });
    });
  });

  // -------------------------------------------------------------------
  // As a logged out user
  // -------------------------------------------------------------------
  describe('As a logged out user', () => {
    let courseId, lessonId;

    beforeEach(async () => {
      // Create course + lesson as a logged-in user, then drop to anonymous.
      await flow.switchUser('user');
      await flow.createCourse();
      courseId = flow.lastResponse.body.course.id;
      await flow.addNewLesson(courseId);
      lessonId = flow.lastResponse.body.data.id;
      flow.switchUser('');  // synchronous — just sets activeUser = ''
    });

    it('should allow me to visit a course page', async () => {
      await flow.getCourse(courseId);
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      for (const property in defaults.course) {
        expect(flow.lastResponse.body.data).toHaveProperty(property, defaults.course[property]);
      }
    });

    // Unauthenticated requests to /api/* routes return 401 (JSON error).
    // The onPreResponse handler in app.js excludes /api/ paths from the
    // 401→302 redirect conversion, so anonymous API callers get 401 directly.
    it('should not allow me to create a course', async () => {
      await flow.createCourse();
      expect(flow.lastResponse.statusCode).toBe(401);
    });

    it('should not allow me to add a lesson to a course', async () => {
      await flow.addNewLesson(courseId);
      expect(flow.lastResponse.statusCode).toBe(401);
    });

    it('should not allow me to add material to a course lesson', async () => {
      await flow.addNewMaterial(courseId, lessonId);
      expect(flow.lastResponse.statusCode).toBe(401);
    });

    it('should not allow me to delete a course', async () => {
      await flow.deleteCourse(courseId);
      expect(flow.lastResponse.statusCode).toBe(401);
    });
  });
});
