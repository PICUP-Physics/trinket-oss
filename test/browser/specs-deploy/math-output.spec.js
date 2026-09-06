const { test, expect } = require('@playwright/test');

// Typeset SymPy output (features.mathOutput), against a REAL deployment.
//
// The local suite (test/browser/specs/math-output.spec.js) covers the feature
// in full against a `make gcp` stack, which has the flag forced on via
// docker-compose.gcr.yml's NODE_CONFIG. A real deploy is not guaranteed to have
// it on — this is why every other feature-gated case in this repo (see
// worker-runtime.spec.js, share-runtime-option.spec.js) reads the flag off
// window.trinket.config and skips rather than asserts when it is off. This
// spec follows that precedent so a deploy without mathOutput reports a clean
// skip, not a failure, while a deploy WITH it on turns the manual "does it
// actually render" look into a recorded check.
//
// Point this at a MAIN-THREAD deploy (rba-merge-trial.spvi.net or
// trial-merge.spvi.net). Slice 1 does not cover the Web Worker runtime — that
// is Task 8, waiting on #215 — so on a worker deploy such as
// trinket-merge-test.web.app the flag reads as on and nothing renders, which
// looks like a failure and is not one. trinket-merge-test becomes the right
// target once Task 8 lands.
//
// Anonymous and read-only, like the rest of deploy-smoke.spec.js, so it is safe
// to run against a live server.

// Set the editor contents and Run, on the page that is already loaded. The
// flag has to be read off the loaded page before deciding whether to run at
// all, so navigation is separate from this rather than folded into it — a
// second goto would throw the first page (and its Pyodide boot) away.
async function editorRun(page, code) {
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

test.describe('typeset SymPy math output', () => {
  test('a bare top-level expression renders a typeset .math-card', async ({ page }) => {
    // Same runtime pin the local suite uses: the worker half of the feature
    // waits on #215 (module-worker conversion), so mathOutput is only wired up
    // on ?runtime=main today.
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor').first()).toBeVisible();

    const enabled = await page.evaluate(() =>
      !!(window.trinket && window.trinket.config && window.trinket.config.mathOutput));
    test.skip(!enabled, 'mathOutput is disabled on this deploy');

    await editorRun(page, [
      'import sympy as sp',
      "x = sp.symbols('x')",
      'x**2 + 1',
    ].join('\n'));

    // Pyodide boots ~10 MB from a CDN and `import sympy` adds ~3.3 s on top of
    // that on first run, so the first assertion of any run gets the generous
    // timeout the rest of this suite uses for a first Pyodide run.
    await expect(async () => {
      expect(await page.locator('#console-output .math-card').count()).toBe(1);
    }).toPass({ timeout: 90_000 });

    // Typeset, not the degraded text fallback: KaTeX actually rendered inside
    // the card's math-body.
    await expect(
      page.locator('#console-output .math-card .math-body .katex')
    ).toHaveCount(1, { timeout: 30_000 });
  });
});
