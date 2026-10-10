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

// #333: the test above does ONE page load and ONE run, which is the one case that
// was fixed. A student runs, edits and runs AGAIN, in the same page, and on the
// worker runtime that second run opened the status line with nothing left to close
// it: "Loading Python (Pyodide)… " stayed open and the program's first output line
// was written onto the end of it. So the first run must announce its boot and
// every run after it must print no status line at all.
//
// Both runtimes are pinned, not left to the deploy's default, so the main-thread
// guard (`if (!pyodideReady)`) is held in place as well as the worker one.
//
// The assertion is "no line STARTS WITH Loading Python", not the dangling-ellipsis
// pattern above: the symptom is the status text joined to the program's output
// ("Loading Python (Pyodide)… SECOND-DONE"), which does not END in an ellipsis and
// so passes the pattern straight through.
for (const [label, query] of [['worker', '?runtime=worker'], ['main', '?runtime=main']]) {
  test.describe(`${label} runtime: a second run in the same page (#333)`, () => {
    test('the first run announces its boot; the second prints no status line', async ({ page }) => {
      await editorRun(page, '/embed/python3' + query, 'print("FIRST-DONE")\n');
      await expect(async () => {
        expect(await consoleText(page)).toContain('FIRST-DONE');
      }).toPass({ timeout: 120_000 });

      const first = (await consoleText(page)).split('\n').map((l) => l.trim()).filter(Boolean);
      expect(first, 'a cold boot must still be announced, and completed')
        .toContain('Loading Python (Pyodide)… ready');

      // The SAME page: no goto, so the interpreter from the first run is warm.
      await page.evaluate((src) => {
        document.querySelector('.ace_editor').env.editor.setValue(src, 1);
      }, 'print("SECOND-DONE")\n');
      await page.locator('.run-it').first().click();
      await expect(async () => {
        expect(await consoleText(page)).toContain('SECOND-DONE');
      }).toPass({ timeout: 60_000 });

      // The console is cleared per run, but do not depend on it: look only at what
      // came after the first run's marker if it is still there.
      const text = await consoleText(page);
      const afterFirst = text.includes('FIRST-DONE')
        ? text.slice(text.lastIndexOf('FIRST-DONE') + 'FIRST-DONE'.length) : text;
      const status = afterFirst.split('\n').map((l) => l.trim())
        .filter((l) => l.startsWith('Loading Python'));

      expect(status, 'a warm second run must not print or leave open a "Loading Python" line: '
        + JSON.stringify(status)).toEqual([]);
    });
  });
}
