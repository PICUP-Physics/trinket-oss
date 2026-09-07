const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap, assertOk } = require('../deploy-auth');

// The course editor must not stamp the authoring deploy's hostname into stored
// material (#245).
//
// The unit test for this is a static source assertion — it reads
// toolbarControl.js and checks the insert builds a bare /embed/ path. That
// pins the code but cannot see what a real browser actually writes, or what
// reaches the database. This does both: it drives the real toolbar in a real
// Angular app against a real deploy, then re-reads the material through the API
// and asserts on the STORED bytes.
//
// The bug it covers: two trials sharing a Firestore. A course authored on one
// opened correctly on the other with every embed still loading from the first
// host, because trinketConfig.getUrl() had baked `protocol://apphostname` into
// content at insert time. It cannot be corrected on serve — getMaterial used to
// normalize hosts, and that broke the editor's patch base so every save
// conflicted forever (M&I #7).
//
//   TRINKET_BASE_URL=https://rba-merge-trial.spvi.net \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/editor-embed-host.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

test.describe('course editor: inserted embeds carry no host', () => {
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
    } else {
      await signIn(page, baseURL, EMAIL, PASSWORD);
    }
  });

  test('inserting a trinket writes a root-relative src, and stores it that way', async ({ page, baseURL }) => {
    const runId = fixtures.runId();

    // A trinket of our own to find in the search — an ephemeral user owns none.
    const tName = runId + ' embed-host';
    const tRes = await api('POST', '/api/trinkets',
      { code: 'print("embed host check")\n', lang: 'python3', name: tName });
    assertOk(expect, tRes, 'creating a trinket to insert');
    const trinket = unwrap(tRes.body, 'trinket');
    expect(trinket && (trinket.trinketId || trinket.id), 'trinket needs an id').toBeTruthy();

    // A course with a page to edit.
    const cRes = await api('POST', '/api/courses',
      { name: fixtures.courseName(runId), description: 'embed host check' });
    assertOk(expect, cRes, 'creating a course');
    const course = unwrap(cRes.body, 'course');
    courseId = course && course.id;

    const lRes = await api('POST', `/api/courses/${courseId}/lessons`, { name: 'Week 1' });
    assertOk(expect, lRes, 'creating a lesson');
    const lesson = unwrap(lRes.body, 'data') || unwrap(lRes.body, 'lesson');
    const lessonId = lesson && lesson.id;

    const mRes = await api('POST', `/api/courses/${courseId}/lessons/${lessonId}/materials`,
      { name: 'Reading', type: 'page', body: 'Intro line.\n' });
    assertOk(expect, mRes, 'creating a page');
    const material = unwrap(mRes.body, 'data') || unwrap(mRes.body, 'material');
    const materialId = material && material.id;

    // From the course's own _owner, not GET /api/user — that route 404s on this
    // deploy, which is what silently disables course-journey.spec.js's old-slug
    // redirect check (it guards on `if (username)`).
    const username = ((course._owner) || {}).username;
    expect(username, 'need the owner slug to build the editor URL').toBeTruthy();

    // --- drive the REAL toolbar ---------------------------------------------
    const editUrl = `/${username}/courses/${course.slug}#/${lesson.slug}/${material.slug}/edit`;
    await page.goto(editUrl);

    // The toolbar's trinket search: a labelled anchor that reveals the input.
    const label = page.locator('#search-label');
    await label.waitFor({ state: 'visible', timeout: 30000 });
    await label.click();

    const search = page.locator('#trinket-search');
    await search.waitFor({ state: 'visible', timeout: 15000 });
    // typeahead-wait-ms is 400, so type and let it settle rather than racing it.
    await search.fill(tName);

    const result = page.locator('.trinket-list-with-lang').first();
    await result.waitFor({ state: 'visible', timeout: 30000 });
    await result.click();

    // --- what the editor now holds ------------------------------------------
    // Ace keeps its content in its own model, not the DOM: reading .editor's
    // innerText returns the gutter line numbers, not the text.
    const editorText = await page.evaluate(() => window.ace.edit('markdown').getValue());
    const m = /<iframe src='([^']+)'/.exec(editorText);
    expect(m, `no iframe was inserted; editor held: ${editorText.slice(0, 300)}`).toBeTruthy();
    const src = m[1];
    console.log(`  [#245] inserted src: ${src}`);

    const host = new URL(baseURL).host;
    expect(src, 'the inserted src must be root-relative').toMatch(/^\/embed\//);
    expect(src, 'no scheme may be baked in').not.toMatch(/https?:/);
    expect(src, 'no protocol-relative host either').not.toMatch(/^\/\//);
    expect(src, 'the authoring host must not appear').not.toContain(host);

    // --- and what actually reaches the DATABASE -----------------------------
    // The insert is only half of it. What pins a course to a deploy is the
    // STORED bytes, so wait for the autosave and read the material back.
    await page.locator('.autosave-done').waitFor({ state: 'visible', timeout: 30000 });

    const stored = await api('GET', `/api/courses/${courseId}/lessons/${lessonId}/materials/${materialId}`);
    assertOk(expect, stored, 'reading the material back');
    const savedContent = ((unwrap(stored.body, 'data') || unwrap(stored.body, 'material')) || {}).content || '';
    console.log(`  [#245] stored: ${savedContent.replace(/\s+/g, ' ').slice(0, 160)}`);

    expect(savedContent, 'the save must have persisted the insert').toContain('/embed/');
    expect(savedContent, 'the authoring host must not be written to storage')
      .not.toContain(host);
    expect(savedContent, 'no absolute embed URL may be stored')
      .not.toMatch(/src=['"]https?:/);
  });

  test.afterEach(async ({ page, baseURL }) => {
    if (!courseId) return;
    await page.request.fetch(new URL(`/api/courses/${courseId}`, baseURL).toString(),
      { method: 'DELETE' }).catch(() => {});
    courseId = null;
  });
});
