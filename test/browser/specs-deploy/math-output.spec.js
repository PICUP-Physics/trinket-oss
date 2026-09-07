const { test, expect } = require('@playwright/test');

// Typeset SymPy output (#240), against a real deploy.
//
// The unit tests cover the AST wrap and the classifier as pure functions. What
// they cannot show is the thing the feature IS: that a bare SymPy expression
// becomes rendered mathematics in a browser, in order with print output. That
// needs Pyodide, SymPy and KaTeX all actually loading.
//
// Skips unless features.mathOutput is on, so it is inert on deploys that have
// not enabled it — and skips on worker deploys, where slice 1 does nothing by
// design (Task 8 follows #215).
async function editorRun(page, path, code) {
  await page.goto(path);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}
const consoleText = (page) =>
  page.evaluate(() => document.querySelector('#console-output')?.innerText || '');

test.describe('typeset SymPy output', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/embed/python3');
    // Read the SERVED page, not a guessed JS object path: the embed config is a
    // flat object, and probing window.trinket.config.features.mathOutput made
    // this spec skip silently on a deploy where the feature was in fact ON.
    // A test that skips when it should run is worse than no test.
    const html = await page.content();
    const cfg = {
      math:   /mathOutput\s*:\s*true/.test(html),
      worker: /workerRuntime\s*:\s*true/.test(html)
    };
    // Say WHY out loud. A silent skip is indistinguishable from a pass in the
    // summary line, and this spec did exactly that: it skipped on a deploy where
    // mathOutput was demonstrably ON, because the detection probed the wrong
    // object. "5 skipped" read as fine. Printing the reason makes a broken
    // detector look different from a feature that is simply off.
    if (!cfg.math)   console.log('  [math-output] SKIP: mathOutput is off on this deploy');
    if (cfg.worker)  console.log('  [math-output] SKIP: worker deploy — slice 1 is main-thread (Task 8 follows #215)');
    if (cfg.math && !cfg.worker) console.log('  [math-output] RUNNING: mathOutput on, main-thread deploy');
    test.skip(!cfg.math, 'features.mathOutput is off on this deploy');
    test.skip(cfg.worker, 'slice 1 is main-thread only; worker parity follows #215');
  });

  test('a bare SymPy expression renders as mathematics', async ({ page }) => {
    await editorRun(page, '/embed/python3',
      'from sympy import symbols, Integral, sqrt\n' +
      'x = symbols("x")\n' +
      'print("BEFORE")\n' +
      'Integral(sqrt(1/x), x)\n' +
      'print("AFTER")\n');

    // KaTeX renders into .katex; that element existing is the proof the whole
    // chain worked — Pyodide, SymPy, the AST hook, the sink and the renderer.
    await expect(page.locator('#console-output .katex').first(),
      'a bare SymPy expression should typeset, not print a repr')
      .toBeVisible({ timeout: 180_000 });

    // Interleaving is the point: math must appear in PROGRAM order.
    const text = await consoleText(page);
    expect(text).toContain('BEFORE');
    expect(text).toContain('AFTER');
    expect(text.indexOf('BEFORE'), 'math must not be hoisted out of program order')
      .toBeLessThan(text.indexOf('AFTER'));
  });

  test('a non-typesettable value stays silent, as a script does', async ({ page }) => {
    // The compatibility guarantee: existing trinkets behave identically.
    await editorRun(page, '/embed/python3', '42\n"a string"\nprint("ONLY THIS")\n');
    await expect(async () => {
      expect(await consoleText(page)).toContain('ONLY THIS');
    }).toPass({ timeout: 180_000 });
    expect(await page.locator('#console-output .katex').count(),
      'ints and strings must not typeset').toBe(0);
  });
});
