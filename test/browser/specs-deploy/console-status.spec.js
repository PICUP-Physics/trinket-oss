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

// #333, the two ways a worker stops being warm. The loop above only proves the
// WARM path; the guard is `!!worker && ready`, and the `!!worker` half exists for
// exactly these. Stop destroys the worker, so the next Run is a cold boot and has
// to announce it again. A bare `ready` flag stays true for a worker that no longer
// exists, and the boot after Stop would then say nothing at all.
//
// Worker runtime only: the main thread has no worker to destroy.
async function waitForText(page, text, timeout) {
  await expect(async () => {
    expect(await consoleText(page)).toContain(text);
  }).toPass({ timeout });
}

async function setCode(page, src) {
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, src);
}

const statusLines = async (page) => (await consoleText(page)).split('\n')
  .map((l) => l.trim()).filter((l) => l.startsWith('Loading Python'));

test.describe('worker runtime: a run after the worker is replaced or reset (#333)', () => {
  test('a run after Stop is a cold boot and says so', async ({ page }) => {
    await editorRun(page, '/embed/python3?runtime=worker', 'print("WARMED")\n');
    await waitForText(page, 'WARMED', 120_000);

    await setCode(page, 'print("LOOPING")\nwhile True:\n    pass\n');
    await page.locator('.run-it').first().click();
    await waitForText(page, 'LOOPING', 60_000);
    const stop = page.locator('.stop-it');
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);                  // let the button settle
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 60_000 });

    await setCode(page, 'print("AFTER-STOP")\n');
    await page.locator('.run-it').first().click();
    await waitForText(page, 'AFTER-STOP', 120_000);

    const lines = (await consoleText(page)).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines, 'Stop destroyed the worker, so this run booted a new one and must say so')
      .toContain('Loading Python (Pyodide)… ready');
    expect(lines.filter((l) => l.startsWith('Loading Python') && l !== 'Loading Python (Pyodide)… ready'),
      'and the status line must be closed, not joined to program output').toEqual([]);
  });

  // Not known in advance whether Clear memory replaces the worker or only resets
  // its globals (pyodide.js says it keeps the loaded interpreter). Both are fine;
  // what is not fine is a status line left open. So this pins the invariant that
  // holds either way and logs which behaviour it saw, which is the answer #333 asks for.
  test('a run after Clear memory leaves no status line open', async ({ page }) => {
    await editorRun(page, '/embed/python3?runtime=worker', 'x = 1\nprint("BEFORE-CLEAR")\n');
    await waitForText(page, 'BEFORE-CLEAR', 120_000);

    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button')]
        .find((e) => /clear memory/i.test(e.textContent || ''));
      if (!el) return false;
      el.click();
      return true;
    });
    expect(clicked, 'the embed offers a Clear memory control').toBe(true);
    await page.waitForTimeout(2500);

    await setCode(page, 'print("AFTER-CLEAR")\n');
    await page.locator('.run-it').first().click();
    await waitForText(page, 'AFTER-CLEAR', 120_000);

    const status = await statusLines(page);
    console.log('  [run after Clear memory] status lines: ' + JSON.stringify(status)
      + (status.length ? '  (worker was replaced)' : '  (worker was reused)'));
    expect(status.filter((l) => l !== 'Loading Python (Pyodide)… ready'),
      'any status line after Clear memory must be closed, never joined to output').toEqual([]);
  });
});
