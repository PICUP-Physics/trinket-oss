const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn } = require('../deploy-auth');

// picup #167 / #166: instructors paste rows straight out of a spreadsheet, which
// arrive TAB-delimited, and some rows have no email at all (a header row, a name
// with the address in another sheet). The parser is unit-tested; what is not is
// the wiring around it — that held-back lines stay in the box instead of
// vanishing, that the message says how many, and that the good rows are actually
// invited.
//
// Opt-in, and it writes, so it follows the same rules as instructor-journey:
// trials only, and it builds its own throwaway course rather than touching a
// shared fixture. See docs/DEPLOY-TESTING.md.
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

// Two good rows and one that has no email — exactly the #166 shape.
const GOOD_1 = 'paste-ada@example.com';
const GOOD_2 = 'paste-blaise@example.com';
const PASTE = [
  ['Ada', 'Lovelace', GOOD_1].join('\t'),
  ['Blaise', 'Pascal', GOOD_2].join('\t'),
  ['Charlie', 'NoAddress', ''].join('\t'),
].join('\n');

test.describe('Add Students accepts a spreadsheet paste', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_STORAGE_STATE, or SMOKE_EMAIL+SMOKE_PASSWORD');
  test.use(STATE ? { storageState: STATE } : {});

  let courseId = null;

  test('adds the rows with emails and keeps the rest in the box', async ({ page, baseURL }) => {
    // Use the shared entry point, not a hand-rolled form fill: a Firebase deploy
    // renders no password field at all, so filling the form times out there even
    // though SMOKE_EMAIL/SMOKE_PASSWORD are perfectly valid. signIn() probes
    // /login and picks form auth or the Identity Toolkit REST path to match.
    if (!STATE) await signIn(page, baseURL, EMAIL, PASSWORD);

    const api = async (method, path, body) => {
      const res = await page.request.fetch(new URL(path, baseURL).toString(), {
        method, headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status(), body: await res.json().catch(() => ({})) };
    };

    const created = await api('POST', '/api/courses',
      { name: fixtures.courseName(fixtures.runId()), description: 'add-students paste test' });
    expect(created.status).toBe(200);
    const course = created.body.course || {};
    courseId = course.id;

    // The editor is the course page itself (GET /{userSlug}/courses/{courseSlug});
    // the Angular app's root route renders course_editor.html.
    const owner = course.ownerSlug || (course._owner || {}).username;
    expect(owner, 'need the owner slug to build the course URL').toBeTruthy();
    // The trailing #/ matters: the Angular app deep-routes to the first material
    // otherwise, and course_editor.html is the ROOT route.
    const res = await page.goto(`/${owner}/courses/${course.slug}#/`);
    expect(res.status(), 'course page should render').toBe(200);

    // Add Students is NOT on the course page. The whole block -- the Add Users
    // button, #add-users-container, invite-users-form and add-student-form --
    // lives inside `<script type="text/ng-template" id="courseUserModal.html">`
    // (course_editor.html:299), so none of it exists in the DOM until the modal
    // is opened by the "Users" button (course_editor.html:25, ng-click=
    // openUserModal, ng-if=canManageAccess).
    //
    // Waiting for the form directly is what an earlier version of this spec did:
    // it timed out after 30s on a page where the feature was working perfectly,
    // with canManageAccess true. Open the modal first.
    // Wait for the editor itself to have rendered before clicking anything: the
    // Users anchor appears in the DOM as soon as Angular evaluates ng-if, but a
    // click that lands mid-bootstrap is swallowed and the modal never opens.
    // course-settings-form is part of the same partial, so its presence means
    // the root route has finished rendering.
    await expect(page.locator('form[name="course-settings-form"]'),
      'course_editor.html should have rendered').toBeAttached({ timeout: 30_000 });

    const usersButton = page.locator('a:has-text("Users")')
      .filter({ has: page.locator('i.fa-users') }).first();
    await expect(usersButton, 'the Users button needs canManageAccess').toBeVisible({ timeout: 30_000 });

    // Retry the open rather than clicking once. Angular re-renders this header
    // as ng-if settles, so a click can land on an anchor that is being replaced
    // and is simply swallowed -- observed roughly one run in two, which read as
    // "the feature is broken" rather than "the click missed".
    const inviteForm = page.locator('form[name="invite-users-form"]');
    await expect(async () => {
      if (!(await inviteForm.count())) await usersButton.click();
      await expect(inviteForm).toBeAttached({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });

    // Two collapses stand between the modal and the textarea, and BOTH must be
    // opened or the click below lands on a zero-height element and times out:
    //   1. #add-users-container carries class="collapsed" until `showAddUsers`
    //      flips -- the "Add Users" button (course_editor.html:305, fa-user-plus,
    //      distinct from the fa-users button that opened this modal).
    //   2. the Add Students fieldset itself, behind its clickable legend (:324).
    const addUsers = page.locator('a:has-text("Add Users")')
      .filter({ has: page.locator('i.fa-user-plus') }).first();
    await addUsers.click();

    const legend = page.locator('legend', { hasText: 'Add Students' }).first();
    await expect(legend, 'the Add Students legend should be clickable once expanded')
      .toBeVisible({ timeout: 15_000 });
    await legend.click();

    const box = page.locator('textarea[ng-model="inviteForm.studentList"]');
    await expect(box).toBeVisible();
    await box.fill(PASTE);
    await page.locator('form[name="invite-users-form"] button[type="submit"]').click();

    // The message should name the held-back line — the behaviour #167 adds.
    // Search the PAGE, not #invitations-sent-messages: usersControl.js:236
    // delivers it with jQuery .notify(), which appends a floating notification
    // to the body and positions it against that element rather than writing
    // into it. Asserting on the element's own text sees "" forever. The local
    // suite's copy of this spec already uses getByText for the same reason.
    await expect(page.getByText(/1 line\(s\) had no email address/i).first(),
      'the held-back line should be reported').toBeVisible({ timeout: 30_000 });

    // #337: the message says whether students are emailed, following the
    // deploy's own mailer check (exposed as inviteEmailEnabled), and never
    // claims delivery, since a failed send is logged and swallowed. One run
    // covers whichever case this trial is; run it on a mail and a no-mail trial.
    const inviteEmail = await page.evaluate(() => window.trinketConfig.get('inviteEmailEnabled'));
    if (inviteEmail === undefined) {
      test.info().annotations.push({ type: 'skip-337', description: 'deploy predates #337 (no inviteEmailEnabled)' });
    } else {
      test.info().annotations.push({ type: 'inviteEmailEnabled', description: String(inviteEmail) });
      if (inviteEmail) {
        await expect(page.getByText(/2 invited\./).first()).toBeVisible();
        await expect(page.getByText(/Trinket is emailing each invited student a link to join/).first()).toBeVisible();
        await expect(page.getByText(/If an email doesn't arrive/).first()).toBeVisible();
        await expect(page.getByText('Everyone else is emailed an invitation with a link to join.'), 'help text: mail deploy').toBeVisible();
      } else {
        await expect(page.getByText(/2 added\./).first()).toBeVisible();
        await expect(page.getByText(/Trinket doesn't email students: give them this site's address/).first()).toBeVisible();
        await expect(page.getByText(/give them this site's address, and they join the course/), 'help text: no-mail deploy').toBeVisible();
      }
      await expect(page.getByText(/has been emailed|have been emailed/), 'never claims delivery').toHaveCount(0);
    }

    // The junk row stays so the instructor can fix it; the good rows do not.
    const left = await box.inputValue();
    expect(left, 'the row without an email should remain').toMatch(/NoAddress/);
    expect(left, 'invited rows should be cleared from the box').not.toMatch(new RegExp(GOOD_1));
    expect(left).not.toMatch(new RegExp(GOOD_2));

    // The two good rows become PENDING INVITATIONS — they are not users until
    // the student signs in with that address — so check /invitations, NOT the
    // roster. /users answers with the course owner alone here, which reads as
    // "nobody was added" when the invitations are in fact sitting there.
    const invites = JSON.stringify((await api('GET', `/api/courses/${courseId}/invitations`)).body);
    expect(invites, 'Ada should have been invited').toContain(GOOD_1);
    expect(invites, 'Blaise should have been invited').toContain(GOOD_2);
    expect(invites, 'the email-less row must never be invited').not.toMatch(/NoAddress/);
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(), { method: 'DELETE' }).catch(() => {});
    courseId = null;
  });
});
