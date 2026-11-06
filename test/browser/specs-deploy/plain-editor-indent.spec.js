const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap } = require('../deploy-auth');

// #367, against a real deployment: the plain-text editor typed "41" for Enter
// after ':' when the account's Python indent was saved as 4 through the
// settings form (Firestore kept the string "4"), and the in-trinket
// Indentation menu never reached the plain editor at all. The unit halves are
// test/lib/util/plainIndent.test.js and test/lib/models/user-settings-types.test.js.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://... \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/plain-editor-indent.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

async function plainEditor(page, marker) {
  await page.waitForFunction((m) =>
    Array.from(document.querySelectorAll('textarea.lined')).some((t) => t.value.includes(m)),
  marker, { timeout: 30000 });
  expect(await page.locator('.ace_editor').count(), 'the plain editor, not ACE').toBe(0);
  return page.locator('textarea.lined').first();
}

// Type a block opener at the end and press Enter; return the new line's indent.
async function indentAfterColon(page, ta) {
  await ta.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('if x:');
  await page.keyboard.press('Enter');
  return ta.evaluate((t) => t.value.slice(t.value.lastIndexOf('\n') + 1));
}

test.describe('plain editor indentation (#367)', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  // Sign in and create a trinket holding a marker line; returns its id.
  async function setup(page, baseURL) {
    const api = apiFor(page, baseURL);
    const runId = fixtures.runId();
    if (STATE) await page.goto('/home');
    else await signIn(page, baseURL, EMAIL, PASSWORD);

    const marker = 'indent_' + runId.replace(/\W/g, '_');
    const res = await api('POST', '/api/trinkets', { code: 'GlowScript 3.2 VPython\n' + marker + ' = 1\n', lang: 'glowscript', name: runId + ' indent' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = unwrap(res.body, 'trinket');
    return { api, marker, id: t.trinketId || t.id };
  }

  test('settings saved through the account forms keep their types', async ({ page, baseURL }) => {
    const { api, marker, id } = await setup(page, baseURL);

    // The settings pages post form fields, exactly as account settings and the
    // editor toggle do (jQuery $.post with a plain object).
    const form = (path, data) => page.request.post(new URL(path, baseURL).toString(), { form: data });

    try {
      // --- account settings: 4 spaces, plain editor ------------------------
      expect((await form('/api/users/settings/indentation', { pythonTab: '4', htmlTab: '2', javaTab: '2', rTab: '2' })).status()).toBe(200);
      expect((await form('/api/users/settings', { disableAceEditor: 'true' })).status()).toBe(200);

      await page.goto(`/embed/glowscript/${id}`);
      let ta = await plainEditor(page, marker);
      expect(await indentAfterColon(page, ta), 'Enter after ":" with a 4-space account setting').toBe('    ');

      // --- turning the plain editor back OFF through the form sticks --------
      expect((await form('/api/users/settings', { disableAceEditor: 'false' })).status()).toBe(200);
      await page.goto(`/embed/glowscript/${id}`);
      await page.waitForSelector('.ace_editor', { timeout: 30000 });
    } finally {
      // JSON, so the restore lands as real types even on a deploy without the fix.
      await api('POST', '/api/users/settings/indentation', { pythonTab: 2, htmlTab: 2, javaTab: 2, rTab: 2 });
      await api('POST', '/api/users/settings', { disableAceEditor: false });
    }
  });

  test('in exam mode, the trinket Indentation menu reaches the plain editor', async ({ page, baseURL, browser }) => {
    const { api, marker, id } = await setup(page, baseURL);
    const on = await api('POST', `/api/trinkets/${id}/autosave`, { settings: { plainEditor: true } });
    expect(on.status, JSON.stringify(on.body)).toBeLessThan(400);

    const anon = await browser.newContext({ baseURL });
    const viewer = await anon.newPage();
    const errors = [];
    viewer.on('pageerror', (e) => errors.push(e.message));
    try {
      await viewer.goto(`/embed/glowscript/${id}`);
      const ta = await plainEditor(viewer, marker);
      await viewer.evaluate(() => { const s = document.getElementById('indentationAmount'); s.value = '4'; window.jQuery(s).trigger('change'); });
      expect(await indentAfterColon(viewer, ta), 'Enter after ":" once the trinket menu says 4 spaces').toBe('    ');
      expect(errors, 'changing the Indentation menu throws nothing').toEqual([]);
    } finally {
      await anon.close();
    }
  });
});
