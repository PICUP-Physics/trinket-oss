const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap } = require('../deploy-auth');

// Exam mode (trinket settings.plainEditor), against a real deployment: a
// LOGGED-OUT viewer of an exam-mode trinket gets the plain-text editor, not
// ACE — including in calculator mode — while an ordinary trinket still gets
// ACE. The server-render half is test/lib/api/examModePlainEditor.test.js;
// this is the half that proves the editor that actually appears.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://... \
//     npx playwright test -c playwright.deploy.config.js specs-deploy/exam-mode.spec.js

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

// Wait until the embed has built an editor holding `marker`, then report which
// kind it built. ACE keeps its text in a hidden textarea too, so the plain
// editor is identified by a textarea holding the whole program AND no ACE.
async function editorKind(page, marker) {
  await page.waitForFunction((m) =>
    document.querySelector('.ace_editor') ||
    Array.from(document.querySelectorAll('textarea')).some((t) => t.value.includes(m)),
  marker, { timeout: 30000 });
  return page.evaluate((m) => ({
    ace   : document.querySelectorAll('.ace_editor').length,
    plain : Array.from(document.querySelectorAll('textarea')).some((t) => t.value.includes(m)),
  }), marker);
}

test.describe('exam mode', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  test('a logged-out viewer gets the plain editor; an ordinary trinket keeps ACE', async ({ page, baseURL, browser }) => {
    const api = apiFor(page, baseURL);
    const runId = fixtures.runId();
    if (STATE) await page.goto('/home');
    else await signIn(page, baseURL, EMAIL, PASSWORD);

    const marker = 'exam_' + runId.replace(/\W/g, '_');
    const code = 'GlowScript 3.2 VPython\n' + marker + ' = 1\nbox()\n';

    async function create(name) {
      const res = await api('POST', '/api/trinkets', { code, lang: 'glowscript', name: runId + ' ' + name });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const t = unwrap(res.body, 'trinket');
      return t.trinketId || t.id;
    }
    const examId = await create('exam');
    const plainId = await create('ordinary');

    const on = await api('POST', `/api/trinkets/${examId}/autosave`, { settings: { plainEditor: true } });
    expect(on.status, JSON.stringify(on.body)).toBeLessThan(400);
    const reread = await api('GET', `/api/trinkets/${examId}`);
    expect(JSON.stringify(reread.body), 'plainEditor must persist').toContain('"plainEditor":true');

    // A fresh context: no session, no user settings — a student in SEB.
    const anon = await browser.newContext({ baseURL });
    const viewer = await anon.newPage();
    try {
      await viewer.goto(`/embed/glowscript/${examId}`);
      expect(await editorKind(viewer, marker), 'exam mode').toEqual({ ace: 0, plain: true });

      await viewer.goto(`/embed/glowscript/${examId}?runMode=calculator`);
      const edit = viewer.locator('.edit-it:visible').first();
      if (await edit.count()) await edit.click();
      expect(await editorKind(viewer, marker), 'exam mode + calculator mode').toEqual({ ace: 0, plain: true });

      // --- #318: indentation help and caret position in the plain editor ----
      await viewer.goto(`/embed/glowscript/${examId}`);
      await editorKind(viewer, marker);
      const ta = viewer.locator('textarea.lined').first();
      const state = () => ta.evaluate((t) => ({ value: t.value, caret: t.selectionStart }));

      await ta.click();
      await viewer.keyboard.press('ControlOrMeta+End');
      await viewer.keyboard.type('for i in range(3):');
      await viewer.keyboard.press('Enter');
      let s = await state();
      const tabSize = s.value.length - s.value.lastIndexOf('\n') - 1;
      expect(tabSize, 'Enter after ":" indents one level').toBeGreaterThan(0);
      await viewer.keyboard.type('pass');
      await viewer.keyboard.press('Enter');
      s = await state();
      expect(s.value.endsWith('\n'), 'Enter after pass steps back out').toBe(true);

      await viewer.keyboard.press('Tab');
      s = await state();
      expect(s.value.endsWith('\n' + ' '.repeat(tabSize)), 'Tab indents in exam mode').toBe(true);
      expect(await ta.evaluate((t) => document.activeElement === t), 'Tab stays in the editor').toBe(true);
      await viewer.keyboard.press('Shift+Tab');
      expect((await state()).value.endsWith('\n'), 'Shift-Tab outdents').toBe(true);

      await viewer.keyboard.press('ControlOrMeta+z');
      expect((await state()).value.endsWith('\n' + ' '.repeat(tabSize)), 'Ctrl-Z undoes the outdent').toBe(true);

      // The caret survives leaving the editor and coming back.
      const before = (await state()).caret;
      expect(before).toBeGreaterThan(0);
      await ta.evaluate((t) => t.blur());
      await ta.focus();
      expect((await state()).caret, 'focus keeps the caret where it was').toBe(before);

      await viewer.goto(`/embed/glowscript/${plainId}`);
      const control = await editorKind(viewer, marker);
      expect(control.ace, 'an ordinary trinket still gets ACE').toBeGreaterThan(0);
    } finally {
      await anon.close();
    }
  });
});
