const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap, assertOk } = require('../deploy-auth');

// Library search (#344), against a real deployment: the dropdown's count
// footer, "See all" reaching a description-only match that isn't in the first
// 20, clearing the search chip, the search-state fixes from the PR review, and
// the folder view's add-to-folder search. The course-editor toolbar's insert
// search is covered end-to-end by editor-embed-host.spec.js; run both.
//
// TRIALS ONLY (no test identities in prod). Each test creates 22 trinkets
// tagged with the run id and deletes them at the end.
//
//   SMOKE_STORAGE_STATE=... TRINKET_BASE_URL=https://<trial> \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/library-search.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

// A term no real trinket contains: letters and digits only, lower case.
const newTag = (suffix) =>
  'ls' + fixtures.runId().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-9) + suffix;

// The list controller's scope, for what the page doesn't print (the sort key,
// and whether a date filter is still a Date).
const listScope = (page) => page.evaluate(() => {
  const s = angular.element(document.querySelector('#listview-options')).scope();
  return {
    sortBy      : s.sortBy,
    name        : s.filters.name,
    q           : s.filters.q,
    afterIsDate : s.filters.updatedAfter instanceof Date,
  };
});

test.describe('library search', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  const ids = [];
  const folders = [];
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

  // 21 name matches + 1 description-only match = 22, more than the 20 shown.
  async function makeMatches(tag) {
    for (let i = 0; i < 21; i++) {
      const res = await api('POST', '/api/trinkets',
        { code: 'pass\n', lang: 'python3', name: tag + ' ' + String(i).padStart(2, '0') });
      assertOk(expect, res, 'creating trinket ' + i);
      const t = unwrap(res.body, 'trinket');
      ids.push(t.trinketId || t.id);
    }
    const notes = await api('POST', '/api/trinkets', { code: 'pass\n', lang: 'python3', name: tag.toUpperCase().slice(0, 2) + ' notes' });
    assertOk(expect, notes, 'creating the description-only trinket');
    const notesT = unwrap(notes.body, 'trinket');
    const notesId = notesT.trinketId || notesT.id;
    ids.push(notesId);
    assertOk(expect, await api('PUT', `/api/trinkets/${notesId}/description`, { description: 'see ' + tag }),
      'setting its description');
  }

  async function typeSearch(page, tag) {
    const label = page.locator('#search-label');
    await label.waitFor({ state: 'visible', timeout: 30000 });
    const input = page.locator('#trinket-search');
    if (!(await input.isVisible())) await label.click();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.fill('');
    await input.fill(tag);
    const footer = page.locator('.trinket-search-footer');
    await expect(footer).toContainText('Showing 20 of 22, best matches first', { timeout: 30000 });
    return footer;
  }

  async function seeAll(page, tag) {
    const footer = await typeSearch(page, tag);
    await expect(footer).toContainText('See all 22 results');
    await footer.click();
    await expect(page.locator('.library-search-chip')).toContainText(tag, { timeout: 15000 });
  }

  // Scroll until the list stops growing; returns the trinket names shown.
  async function loadAll(page) {
    const cards = page.locator('h3.trinketLabel');
    let n = -1;
    for (let i = 0; i < 15; i++) {
      const now = await cards.count();
      if (now === n && now > 0) break;
      n = now;
      await page.mouse.wheel(0, 6000);
      await page.waitForTimeout(1000);
    }
    return cards.allTextContents().then((t) => t.map((s) => s.trim()));
  }

  async function openFirstAndComeBack(page) {
    await page.locator('h3.trinketLabel').first().click();
    await page.waitForURL((u) => /\/library\/trinkets\/[^/]+/.test(u.pathname), { timeout: 15000 });
    await page.goBack();
    await expect(page.locator('.library-search-chip')).toBeVisible({ timeout: 15000 });
  }

  test('count footer, See all, and the search chip', async ({ page }) => {
    const tag = newTag('a');
    await makeMatches(tag);

    // The API first: the total the footer will show.
    const s = await api('GET', '/api/trinkets/search?q=' + tag);
    expect(s.body.total, JSON.stringify(s.body).slice(0, 300)).toBe(22);
    expect(s.body.data).toHaveLength(20);

    // --- the dropdown --------------------------------------------------------
    await page.goto('/library/trinkets');
    await seeAll(page, tag);
    const chip = page.locator('.library-search-chip');
    await expect(chip).toContainText('(name or instructions)');

    // The description-only match ranks last (22nd), so it only appears once
    // the list pages past the first 20. Scroll until it does.
    const notesCard = page.getByText(/ notes$/).first();
    for (let i = 0; i < 10 && !(await notesCard.isVisible()); i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(800);
    }
    await expect(notesCard).toBeVisible();

    // --- open a result, come Back: still the same search ----------------------
    await notesCard.click();
    await page.waitForURL((u) => /\/library\/trinkets\/[^/]+/.test(u.pathname), { timeout: 15000 });
    await page.goBack();
    await expect(chip).toContainText(tag, { timeout: 15000 });

    // --- clearing the chip ---------------------------------------------------
    await chip.locator('a').click();
    await expect(chip).toHaveCount(0);
  });

  // Copilot review on #346: each step here failed before 3e767f1.
  test('sort, date filter and name filter survive a search; the chip clears from the keyboard', async ({ page }) => {
    const tag = newTag('b');
    await makeMatches(tag);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/library/trinkets');
    await seeAll(page, tag);
    expect((await listScope(page)).sortBy).toBe('relevance');

    // --- a sort picked during the search survives Back, and paging after it
    //     neither repeats nor skips (it used to resume in relevance order over
    //     items and a cursor loaded by name).
    await page.locator('button[data-dropdown="library-sort-options"]').click();
    await page.locator('#library-sort-options a', { hasText: 'Name' }).click();
    await expect.poll(async () => (await listScope(page)).sortBy).toBe('name');
    await openFirstAndComeBack(page);            // after the first page only
    expect((await listScope(page)).sortBy, 'Back keeps the Name sort').toBe('name');
    const names = await loadAll(page);
    expect(names, 'every match, once each, after Back').toHaveLength(22);
    expect(new Set(names).size).toBe(22);
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names, 'still in name order').toEqual(sorted);

    // --- a date filter set during the search is still a Date after Back
    //     (it came back a string and the date input threw ngModel:datefmt).
    await page.locator('button.bulk-filter-toggle').click();
    await page.locator('input.bulk-filter-after').fill('2020-01-01');
    await expect.poll(async () => (await listScope(page)).afterIsDate).toBe(true);
    await openFirstAndComeBack(page);
    expect((await listScope(page)).afterIsDate, 'date filter is still a Date').toBe(true);
    expect(await page.locator('input.bulk-filter-after').inputValue()).toBe('2020-01-01');

    // --- a second See all clears a name filter applied during the first
    //     (it used to keep it, hiding matches the dropdown counted).
    if (!(await page.locator('input.bulk-filter-name').isVisible())) {
      await page.locator('button.bulk-filter-toggle').click();
    }
    await page.locator('input.bulk-filter-name').fill('nomatch');
    await expect.poll(async () => (await listScope(page)).name).toBe('nomatch');
    await seeAll(page, tag);
    expect((await listScope(page)).name, 'second See all clears the name filter').toBe('');
    expect(await loadAll(page), 'and lists every match again').toHaveLength(22);

    // --- the chip's clear link is reachable and works from the keyboard -------
    const clear = page.locator('.library-search-chip a');
    await clear.focus();
    expect(await clear.evaluate((a) => document.activeElement === a), 'the clear link takes focus').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('.library-search-chip')).toHaveCount(0);
    expect((await listScope(page)).q).toBeUndefined();

    expect(errors.filter((e) => /datefmt|ngModel/i.test(e)), 'no Angular model errors').toEqual([]);
  });

  // A sort picked while See all's relevance load is still in flight: that
  // load's late response used to fill a list labelled Name, and the next page
  // then repeated items and skipped others. The relevance response is held
  // back so the race happens on every run, not only on a slow server.
  test('a sort picked while See all is still loading wins over the late results', async ({ page }) => {
    const tag = newTag('d');
    await makeMatches(tag);
    const byName = await api('GET', `/api/trinkets?q=${tag}&scope=all&sort=name&limit=20`);
    const firstPage = unwrap(byName.body, 'data').map((t) => t.name);
    expect(firstPage).toHaveLength(20);

    await page.route('**/api/trinkets?*', async (route) => {
      if (/sort=relevance/.test(route.request().url())) {
        await new Promise((r) => setTimeout(r, 3000));
      }
      await route.continue().catch(() => {});
    });

    await page.goto('/library/trinkets');
    await seeAll(page, tag);
    await page.locator('button[data-dropdown="library-sort-options"]').click();
    await page.locator('#library-sort-options a', { hasText: 'Name' }).click();

    const cards = page.locator('h3.trinketLabel');
    await expect(cards).toHaveCount(20, { timeout: 15000 });
    await page.waitForTimeout(4000);             // let the held-back response land
    const shown = (await cards.allTextContents()).map((s) => s.trim());
    expect(shown, 'the first page in name order, not the late relevance page').toEqual(firstPage);

    const names = await loadAll(page);
    expect(names, 'every match, once each').toHaveLength(22);
    expect(new Set(names).size).toBe(22);
  });

  test('folder view: the count footer, no See all, and adding a result', async ({ page }) => {
    const tag = newTag('c');
    await makeMatches(tag);
    const res = await api('POST', '/api/folders', { name: tag + ' folder' });
    assertOk(expect, res, 'creating the folder');
    const folder = unwrap(res.body, 'folder');
    folders.push(folder.id);

    await page.goto('/library/folder/' + folder.slug);
    const footer = await typeSearch(page, tag);
    await expect(footer, 'See all is the library list\'s alone').not.toContainText('See all');

    // Picking a result adds it to the folder (search results need an id for
    // addToFolder; they had none before #346).
    const first = page.locator('a.trinket-list-with-lang', { hasText: tag }).first();
    const picked = (await first.textContent()).trim();
    await first.click();
    const card = page.locator('h3.trinketLabel', { hasText: picked });
    await expect(card, 'the picked trinket appears in the folder').toBeVisible({ timeout: 15000 });
    // ...and is really stored there: a fresh load of the folder still shows it.
    await page.reload();
    await expect(card, 'still in the folder after a reload').toBeVisible({ timeout: 30000 });
  });

  test.afterEach(async () => {
    if (ids.length) {
      await api('POST', '/api/trinkets/bulk', { action: 'delete', ids: ids.splice(0) }).catch(() => {});
    }
    for (const id of folders.splice(0)) {
      await api('DELETE', `/api/folders/${id}`).catch(() => {});
    }
  });
});
