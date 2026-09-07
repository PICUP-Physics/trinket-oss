const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap, assertOk } = require('../deploy-auth');

// The instructor's ordinary week, against a REAL deployment: build a course,
// rename it, add a topic, a page and an assignment, and put students on the
// roster.
//
// Why this exists: #204. Add Students returned HTTP 200 and added NOBODY, on
// every deploy, from the moment the spreadsheet-paste parser shipped — and it
// took five days and an instructor's email to notice, because nothing exercised
// the whole flow against a running server. A test that only asserts `200` would
// STILL not catch it. So the roster test below asserts the roster actually
// changed, which is the only thing an instructor cares about.
//
// Writes, so it is opt-in and cleans up after itself:
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://... \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/course-journey.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

test.describe('instructor course journey', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  let courseId = null;
  let api;

  test.beforeEach(async ({ page, baseURL }) => {
    api = apiFor(page, baseURL);
    if (STATE) {
      const res = await page.goto('/home');
      expect(res.status(), 'captured session should still be valid').toBeLessThan(400);
      expect(page.url(), 'a stale session redirects to /login').not.toMatch(/\/login/);
    } else {
      await signIn(page, baseURL, EMAIL, PASSWORD);
    }
  });

  test('create, rename, populate and enrol — the whole instructor loop', async ({ page, baseURL }) => {
    const runId = fixtures.runId();

    // --- create -------------------------------------------------------------
    const created = await api('POST', '/api/courses',
      { name: fixtures.courseName(runId), description: 'deploy journey' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const course = unwrap(created.body, 'course');
    courseId = course && course.id;
    expect(courseId, 'course should come back with an id').toBeTruthy();

    // --- rename, and the OLD slug must still resolve ------------------------
    // Renaming changes the slug, and stale links (an LMS, a syllabus, a
    // bookmark) keep pointing at the old one. That 500'd until the routeParser
    // shim; this is the deployed-server check that it still holds.
    const originalSlug = course.slug;
    // Course rename is PUT .../metadata — there is no .../name route on a course
    // (lessons and materials have one; courses do not).
    const renamed = await api('PUT', `/api/courses/${courseId}/metadata`,
      { name: fixtures.courseName(runId) + ' renamed' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBeLessThan(400);

    // Check the USER-FACING url, not the API: /api/courses/{id} takes an id, and
    // handing it a slug is just a cast error. What matters is that a bookmark or
    // an LMS link built before the rename still lands somewhere — a 301 to the
    // new slug. This is the deployed-server check on the routeParser shim.
    if (originalSlug) {
      // From the course's own _owner. This used to read GET /api/user, which
      // 404s on these deploys — so `username` was always undefined and the
      // guard below silently skipped this entire check. It had never run.
      const username = ((course._owner) || {}).username;
      expect(username, 'the course should carry its owner').toBeTruthy();
      if (username) {
        const viaOldSlug = await page.request.fetch(
          new URL(`/${username}/courses/${originalSlug}`, baseURL).toString(),
          { maxRedirects: 0 });
        expect([301, 302],
          'a pre-rename course link must redirect, not break'
        ).toContain(viaOldSlug.status());
      }
    }

    // --- a topic, a page, an assignment -------------------------------------
    const lessonRes = await api('POST', `/api/courses/${courseId}/lessons`, { name: 'Week 1' });
    expect(lessonRes.status, JSON.stringify(lessonRes.body)).toBe(200);
    const lessonId = (unwrap(lessonRes.body, 'lesson') || {}).id;
    expect(lessonId).toBeTruthy();

    const pageRes = await api('POST', `/api/courses/${courseId}/lessons/${lessonId}/materials`,
      { name: 'Reading', type: 'page', body: 'Some **notes** for the week.' });
    assertOk(expect, pageRes, 'creating a page material');

    // type:assignment REQUIRES trinketId — omitting it 500s (#182/#212).
    const asgRes = await api('POST', `/api/courses/${courseId}/lessons/${lessonId}/materials`,
      { name: 'Assignment 1', type: 'assignment', trinketId: '_blank_', lang: 'python3' });
    assertOk(expect, asgRes, 'creating an assignment');
    const assignment = unwrap(asgRes.body, 'material');
    expect(assignment.trinket, 'an assignment must get its prompt trinket').toBeTruthy();

    // --- the roster: #204 ---------------------------------------------------
    // Post EXACTLY what the browser's paste parser emits, `line` included. That
    // extra field is what the schema used to reject, and rejection here answers
    // 200-with-a-flash rather than 4xx — so status alone cannot see it.
    const before = await api('GET', `/api/courses/${courseId}/invitations`);
    const beforeCount = ((before.body && (before.body.data || before.body.invitations)) || []).length;

    const roster = await api('POST', `/api/courses/${courseId}/invitations`, {
      students: [
        { email: runId + '-a@example.com', name: 'Alpha Student',
          line: 'Alpha, Student, ' + runId + '-a@example.com' },
        { email: runId + '-b@example.com', name: 'Beta Student',
          line: 'Beta, Student, ' + runId + '-b@example.com' },
      ],
    });
    // Not `toBe(200)`: #204 WAS a 200. This also fails on the validation flash.
    assertOk(expect, roster, 'Add Students');

    // The assertion that would have caught #204 five days earlier: the roster
    // actually grew. `200` did not.
    const after = await api('GET', `/api/courses/${courseId}/invitations`);
    const afterCount = ((after.body && (after.body.data || after.body.invitations)) || []).length;
    expect(afterCount,
      'Add Students returned 200 but the roster did not grow — this is #204'
    ).toBeGreaterThan(beforeCount);
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(),
      { method: 'DELETE' }).catch(() => {});
    courseId = null;
  });
});
