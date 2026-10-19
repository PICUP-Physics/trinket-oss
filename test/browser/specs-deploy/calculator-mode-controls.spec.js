const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap, assertOk } = require('../deploy-auth');

// Calculator mode (?runMode=calculator) drops Download (#347) and the account
// menu (#291), against a real deployment. Each check first shows the ordinary
// embed HAS the control, so a renamed selector can't pass vacuously. The
// calculator checks are soft, so one run reports every control that leaks. The
// server-render half is test/lib/api/calculatorModeControls.test.js; this half
// proves the embed's own script (toggleUI, which renders the account menu from
// a template calculator mode no longer sends) still loads without errors.
//
// The signed-in case runs as the trinket's owner, whose menu carries the same
// "View on trinket" / "My Trinkets" links a signed-in student's does.
//
// TRIALS ONLY (no test identities in prod). Creates two trinkets and deletes them.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://<trial> \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/calculator-mode-controls.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

const DOWNLOAD = '[data-action="mode.download"]';
const LIBRARY  = '#userMenu a[href="/library/trinkets"]';
const LOGIN    = '#accountForm';

// Load an embed, record uncaught page errors, and give its startup script a
// moment to render the menus (toggleUI runs after the page's own load).
async function open(page, path) {
  const errors = [];
  const onError = (e) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.goto(path);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  page.off('pageerror', onError);
  return errors;
}

test.describe('calculator mode controls', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  const ids = [];
  let api;

  test.beforeEach(async ({ page, baseURL }) => {
    api = apiFor(page, baseURL);
    if (STATE) await page.goto('/home');
    else await signIn(page, baseURL, EMAIL, PASSWORD);
  });

  async function create(lang, code, name) {
    const res = await api('POST', '/api/trinkets', { lang, code, name: fixtures.runId() + ' ' + name });
    assertOk(expect, res, 'creating the ' + lang + ' trinket');
    const t = unwrap(res.body, 'trinket');
    ids.push(t.trinketId || t.id);
    return t.trinketId || t.id;
  }

  test('no Download, no library links, no Log In', async ({ page, baseURL, browser }) => {
    const py   = await create('python3', 'print(1)\n', 'calc download');
    const glow = await create('glowscript', 'GlowScript 3.2 VPython\nbox()\n', 'calc menu');

    // --- Download (#347), signed in ------------------------------------------
    await open(page, `/embed/python3/${py}`);
    expect(await page.locator(DOWNLOAD).count(), 'ordinary embed offers Download').toBeGreaterThan(0);
    let errors = await open(page, `/embed/python3/${py}?runMode=calculator`);
    expect.soft(await page.locator(DOWNLOAD).count(), 'calculator mode: no Download').toBe(0);
    expect(errors, 'python3 calculator embed loads without script errors').toEqual([]);

    // --- library links (#291), signed in ---------------------------------------
    await open(page, `/embed/glowscript/${glow}`);
    await expect(page.locator(LIBRARY), 'ordinary embed: menu links to the library').toHaveCount(1);
    errors = await open(page, `/embed/glowscript/${glow}?runMode=calculator`);
    expect.soft(await page.locator('a[href*="/library/trinkets"]').count(), 'calculator mode: no library links').toBe(0);
    expect(errors, 'glowscript calculator embed loads without script errors').toEqual([]);

    // --- Log In form (#291), signed out: a student in SEB ----------------------
    const anon = await browser.newContext({ baseURL });
    const viewer = await anon.newPage();
    try {
      await open(viewer, `/embed/glowscript/${glow}`);
      await expect(viewer.locator(LOGIN), 'ordinary embed: guest Log In form').toHaveCount(1);
      errors = await open(viewer, `/embed/glowscript/${glow}?runMode=calculator`);
      expect.soft(await viewer.locator(LOGIN).count(), 'calculator mode: no Log In form').toBe(0);
      expect.soft(await viewer.locator('[data-action="login"]').count(), 'calculator mode: no Log In button').toBe(0);
      expect(errors, 'signed-out calculator embed loads without script errors').toEqual([]);

      errors = await open(viewer, `/embed/python3/${py}?runMode=calculator`);
      expect.soft(await viewer.locator(DOWNLOAD).count(), 'signed out, calculator mode: no Download').toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await anon.close();
    }
  });

  test.afterEach(async () => {
    if (ids.length) {
      await api('POST', '/api/trinkets/bulk', { action: 'delete', ids: ids.splice(0) }).catch(() => {});
    }
  });
});
