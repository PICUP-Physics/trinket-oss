const { test, expect } = require('@playwright/test');

// #27, twice now: the embed console printed "Loading Python (Pyodide)…" and
// nothing ever completed it, so students waited on something already finished.
// a5f92de fixed it; the #108 worker-runtime merge silently reverted it five
// weeks later. Nothing asserts console status ORDERING, so CI could not see
// either event — this is that assertion, promised on #229's review.
async function editorRun(page, path, code) {
  await page.goto(path);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

async function consoleText(page) {
  return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
}

test.describe('embed console status lines complete', () => {
  test('no status line still dangles once program output appears', async ({ page }) => {
    await editorRun(page, '/embed/python3', 'print("MARKER-DONE")\n');
    await expect(async () => {
      expect(await consoleText(page)).toContain('MARKER-DONE');
    }).toPass({ timeout: 120_000 });   // pyodide fetches its runtime on first run

    const lines = (await consoleText(page)).split('\n').map((l) => l.trim()).filter(Boolean);
    const dangling = lines.filter((l) => /^Loading .*(…|\.\.\.)$/.test(l));

    expect(dangling, 'status lines still reading as in-progress after the run finished: '
      + JSON.stringify(dangling)).toEqual([]);
  });
});
