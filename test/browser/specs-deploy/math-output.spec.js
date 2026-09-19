const { test, expect } = require('@playwright/test');

// Typeset SymPy output (#240), against a real deploy.
//
// The unit tests cover the AST wrap and the classifier as pure functions. What
// they cannot show is the thing the feature IS: that a bare SymPy expression
// becomes rendered mathematics in a browser, in order with print output. That
// needs Pyodide, SymPy and KaTeX all actually loading.
//
// NO SPEC IN THIS FILE PINS A RUNTIME. Every navigation goes to a bare
// /embed/python3, so the suite exercises whichever runtime the deploy defaults
// to, and one CI deploy proves one side. The specs that say "on both runtimes"
// are claims earned across two runs, neither of which proves them alone. Both
// were done by hand on 2026-09-18: this file as committed against a worker
// deploy (6 passed), and the same assertions against ?runtime=main by
// TEMPORARILY pointing these navigations at it (6 passed). The second is
// evidence about the assertions, not about this file as CI would run it --
// nobody has run it against a main-thread deploy. Note also that the `worker`
// flag below is read from the served HTML, so it reports the DEPLOY's default
// and would still say
// "WORKER deploy" for a spec that forced ?runtime=main.
//
// Skips unless features.mathOutput is on, so it is inert on deploys that have
// not enabled it. It NO LONGER skips on worker deploys: #288 implemented the
// worker half, and this spec is the positive control for it. Before #288 the
// skip was hiding the one place the feature was broken — flag-on and flag-off
// produced identical output there, so nothing could tell.
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

// textContent, NOT innerText. Below about 1100 px the embed makes the output
// pane tabbed, so #console-output is in the DOM with the run's text in it while
// innerText returns '' — a finished run reads as one that never started, and the
// wait burns its full timeout before failing for the wrong reason.
const consoleTextContent = (page) =>
  page.evaluate(() => document.querySelector('#console-output')?.textContent || '');

// Open the interactive console WITHOUT running anything first. At narrow widths
// Run is a split button and clicking `.run-it` opens its menu instead, so this
// goes at the Console entry directly.
async function openConsole(page, path) {
  await page.goto(path);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a.menu-button'))
      .find(e => /^\s*Console\s*$/.test(e.textContent || ''));
    window.jQuery(a).trigger('click');
  });
  await expect(async () => {
    expect(await consoleTextContent(page)).toContain('>>>');
  }).toPass({ timeout: 180_000 });
}

// Push one statement at the jqconsole prompt and wait for the prompt to return.
async function replPush(page, statement) {
  const before = await page.evaluate(() =>
    (document.querySelector('#console-output')?.textContent || '').length);
  await page.evaluate((s) => {
    const jq = window.jQuery('#console-output').data('jqconsole');
    jq.SetPromptText(s);
    jq._HandleEnter();
  }, statement);
  await expect(async () => {
    const t = await consoleTextContent(page);
    expect(t.length).toBeGreaterThan(before);
    expect(t.trimEnd().endsWith('>>>')).toBe(true);
  }).toPass({ timeout: 180_000 });
}

test.describe('typeset SymPy output', () => {
  // The per-assertion timeouts below are 180-240 s because Pyodide, SymPy and
  // KaTeX all have to load, and on the worker a cold interpreter boots first.
  // None of them can be reached without raising the ENCLOSING test timeout.
  // test/browser/playwright.deploy.config.js -- the config that owns this
  // directory (testDir: './specs-deploy') -- sets timeout: 90_000, so without
  // this line the test is killed at 90 s and a matcher waiting 180 or 240 never
  // gets there. A slow Pyodide download then reports as a failure rather than
  // as a slow download. specs-deploy/step-debugger.spec.js:59 raises it for the
  // same reason and says so at :50-58.
  //
  // That config also sets expect: { timeout: 20_000 }, which is why every long
  // wait here passes its own timeout explicitly. The two that do not -- the
  // `.ace_editor` visibility checks in editorRun() and openConsole() -- want the
  // page's JS bundle, not Pyodide, and land well inside 20 s.
  //
  // 300_000, and the value has to EXCEED the largest assertion timeout in any
  // test it covers -- not equal it. Three tests here wait 240 s, and at a 240 s
  // block the TEST cap fires at the same moment, so the assertion still never
  // reports on its own terms: you get "Test timeout of 240000ms exceeded"
  // instead of the message naming what the student did not see. That is the
  // same defect this line exists to fix, in weak form. Measured.
  //
  // Not lower for the fast tests either: four of these carry 180 s waits, so a
  // 120 s block with per-test raises on the slow ones would put those four back
  // exactly where this line found them.
  //
  // The cost is that `retries: 1` makes a genuine failure cost 2 x the block --
  // measured at 8:02 for one failing test at 240 s -- which is the right trade
  // for a suite no workflow runs (#293) and which has, for that reason, never
  // executed under this config at all. See #302 for the repo-wide version.
  test.describe.configure({ timeout: 300_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/embed/python3');
    // Read the SERVED page, not a guessed JS object path: the embed config is a
    // flat object, and probing window.trinket.config.features.mathOutput made
    // this spec skip silently on a deploy where the feature was in fact ON.
    // A test that skips when it should run is worse than no test.
    const html = await page.content();
    const cfg = {
      math:   /mathOutput\s*:\s*true/.test(html),
      worker: /workerRuntime\s*:\s*true/.test(html),
      wvpy:   /workerVPython\s*:\s*true/.test(html)
    };
    // Stashed so the VPython parity test below can gate on it without reading
    // the served page a second time.
    page.__mathCfg = cfg;
    // Say WHY out loud. A silent skip is indistinguishable from a pass in the
    // summary line, and this spec did exactly that: it skipped on a deploy where
    // mathOutput was demonstrably ON, because the detection probed the wrong
    // object. "5 skipped" read as fine. Printing the reason makes a broken
    // detector look different from a feature that is simply off.
    if (!cfg.math) console.log('  [math-output] SKIP: mathOutput is off on this deploy');
    // The runtime is NOT a skip condition any more, but it is still worth
    // naming: the two runtimes reach the same cards by different routes (a
    // direct JS call on the page, a posted `rich` message from the worker), so
    // a failure reads very differently depending on which one ran.
    if (cfg.math) {
      console.log('  [math-output] RUNNING: mathOutput on, ' +
                  (cfg.worker ? 'WORKER' : 'main-thread') + ' deploy');
    }
    test.skip(!cfg.math, 'features.mathOutput is off on this deploy');
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

    // Interleaving is the point: the card must appear BETWEEN the two prints,
    // not merely somewhere on the page. Asserting only BEFORE < AFTER passes
    // even if the card lands at the very end, which is the specific way the
    // worker could have failed: `rich` and `stdout` are separate messages there
    // and stdout is batched, so program order is a property to prove, not to
    // assume. The card carries an echo of the source line, which is what makes
    // its position findable in the console text.
    const text = await consoleText(page);
    expect(text).toContain('BEFORE');
    expect(text).toContain('AFTER');
    const card = text.indexOf('Integral(sqrt(1/x), x)');
    expect(card, 'the card should echo the source line it came from').toBeGreaterThan(-1);
    expect(card, 'the card must not be hoisted above the print that precedes it')
      .toBeGreaterThan(text.indexOf('BEFORE'));
    expect(card, 'the card must not sink below the print that follows it')
      .toBeLessThan(text.indexOf('AFTER'));
  });

  test('display() typesets instead of raising (#288)', async ({ page }) => {
    // The documented escape hatch, and the half that FAILED LOUDLY on the
    // worker before #288: `display` is installed as a builtin by
    // _trinket_display.install(), which only the main thread called, so a
    // worker run raised NameError and halted the program at that line.
    await editorRun(page, '/embed/python3',
      'from sympy import symbols, Integral, sqrt\n' +
      'x = symbols("x")\n' +
      'display(Integral(sqrt(1/x), x))\n' +
      'print("AFTER")\n');

    await expect(page.locator('#console-output .katex').first(),
      'display() should typeset its argument')
      .toBeVisible({ timeout: 180_000 });

    const text = await consoleText(page);
    expect(text, 'display() must not raise').not.toContain('NameError');
    expect(text, 'the program must keep running past the display() call')
      .toContain('AFTER');
  });

  test('display() works at the console BEFORE any Run (#294 review)', async ({ page }) => {
    // The main thread installs the display helper during boot, ahead of its
    // Clear-memory snapshot, so `display` is a builtin the moment a trinket
    // opens. The worker installed it only inside run(), so typing this at a
    // fresh prompt raised NameError there and worked on the main thread —
    // opening a trinket and typing at the console is ordinary student
    // behaviour, and `Clear memory` returns a student to exactly this state.
    await openConsole(page, '/embed/python3');
    await replPush(page, 'from sympy import symbols, Integral; x = symbols("x")');

    // Vacuity guard: the import really landed, so a NameError below would be
    // about `display` and not about `Integral`.
    expect(await consoleTextContent(page), 'the sympy import must have succeeded')
      .not.toContain('ModuleNotFoundError');

    await replPush(page, 'display(Integral(x, x))');

    // Symptom first: what the student sees is a rendered formula.
    await expect(page.locator('#console-output .katex').first(),
      'display() at a fresh prompt should typeset on BOTH runtimes')
      .toBeVisible({ timeout: 180_000 });
    expect(await consoleTextContent(page), 'display must be installed before the first Run')
      .not.toContain('NameError');
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

  test('a VPython program does NOT typeset, on either runtime (#294 review)', async ({ page }) => {
    // runVpython() on the page says in as many words that VPython is
    // deliberately not routed through the display hook — typeset output is
    // slice 1, the plain run and worker paths. The worker prepared and applied
    // the hook for every run including VPython, so the same program produced a
    // card on a worker deploy and none on the main thread.
    //
    // Gated on workerVPython for the same reason the suite is gated on
    // mathOutput: on a deploy without it, a worker VPython run is not the thing
    // under test.
    const cfg = page.__mathCfg || {};
    test.skip(cfg.worker && !cfg.wvpy,
      'worker deploy without features.workerVPython — the divergence is unreachable');

    await editorRun(page, '/embed/python3',
      'from vpython import *\n' +
      'from sympy import symbols, Integral\n' +
      'x = symbols("x")\n' +
      'sphere(pos=vector(0,0,0), radius=1)\n' +
      'Integral(x, x)\n' +
      'print("VPY-DONE")\n');

    await expect(async () => {
      expect(await consoleTextContent(page)).toContain('VPY-DONE');
    }).toPass({ timeout: 240_000 });

    // Vacuity guard, and it is the whole test: without a scene this program did
    // not take the VPython path at all, and "no cards" would prove nothing.
    expect(await page.locator('#graphic canvas').count(),
      'the VPython path must actually have run — no scene means no test')
      .toBeGreaterThan(0);

    expect(await page.locator('#console-output .katex').count(),
      'a VPython run must not typeset: the main thread does not, so neither may the worker')
      .toBe(0);
  });

  test('display() still works INSIDE a VPython program (#294 review, round 1)', async ({ page }) => {
    // The other half, and the first attempt at the test above could not see it.
    // Skipping the AST wrap for VPython must not also skip INSTALLING the
    // helper: the main thread installs at boot for every run, VPython included,
    // so gating both left display() raising NameError on the worker and
    // rendering on the main thread -- and the program died at that line.
    //
    // "No bare-expression card" is satisfied by both the correct gate and the
    // over-gate, which is why this assertion has to exist separately.
    const cfg = page.__mathCfg || {};
    test.skip(cfg.worker && !cfg.wvpy,
      'worker deploy without features.workerVPython — the divergence is unreachable');

    await editorRun(page, '/embed/python3',
      'from vpython import *\n' +
      'from sympy import symbols, Integral\n' +
      'x = symbols("x")\n' +
      'sphere(pos=vector(0,0,0), radius=1)\n' +
      'display(Integral(x, x))\n' +
      'print("VPY-DISPLAY-DONE")\n');

    // Symptom first: the student asked for a formula and must get one.
    await expect(page.locator('#console-output .katex').first(),
      'display() must typeset inside a VPython program on BOTH runtimes')
      .toBeVisible({ timeout: 240_000 });

    const text = await consoleTextContent(page);
    expect(text, 'display() must not raise inside a VPython program')
      .not.toContain('NameError');
    expect(text, 'the program must survive past the display() call')
      .toContain('VPY-DISPLAY-DONE');

    // Vacuity guard last: without a scene this was never a VPython run.
    expect(await page.locator('#graphic canvas').count(),
      'the VPython path must actually have run — no scene means no test')
      .toBeGreaterThan(0);
  });

  // Deliberately fixme, not an assertion on what happens today.
  //
  // A display() card carries a source echo -- "N  <the line that produced it>"
  // -- set by _trinket_display.set_source(), which runs inside runProgram()
  // (and once at install(), with an empty source). Both runtimes bypass
  // runProgram for VPython, so neither sets
  // it, and the card echoes whatever was left over: on the main thread, line N
  // of the LAST PLAIN PROGRAM that ran (measured: a card reading
  // "5  ZZZ_STALE_ECHO_MARKER = 42" beside a correct integral); on the worker,
  // nothing at all, because discardWorker() gives every worker VPython run a
  // fresh interpreter.
  //
  // This predates the worker feature -- the main-thread half is on origin/main
  // today and reaches any deploy with mathOutput on. The stale variant also
  // needs the previous program to be at least as long as the display() line
  // number -- otherwise _source_at()'s `lineno > len(_source_lines)` guard
  // returns '' and the echo is blank instead. Asserting either current
  // behaviour would lock the bug in and go red the day it is fixed, so this
  // states the CONTRACT and stays out of the way until then.
  //
  // Tracked as #303. Un-skip this as the verification when that lands -- it
  // fails today in about 6 s on the blank echo, not by timeout, so it costs
  // seconds if it is ever un-skipped early.
  //
  // ONE run, not two. Reproducing the STALE variant needs two runs in one page
  // session AND a first program at least as long as the display() line number,
  // and editorRun() begins with page.goto() -- a page load destroys the
  // interpreter holding _source_lines, so a two-call version would set up
  // nothing and quietly assert the blank case instead. The blank echo is enough
  // to state the contract; the stale variant belongs in the bug report.
  test.fixme('a VPython display() card echoes the line that produced it (#303)', async ({ page }) => {
    await editorRun(page, '/embed/python3',
      'from vpython import *\n' +
      'from sympy import symbols, Integral\n' +
      'x = symbols("x")\n' +
      'sphere(radius=1)\n' +
      'display(Integral(x, x))\n' +
      'print("VPY-DONE")\n');
    await expect(page.locator('#console-output .katex').first())
      .toBeVisible({ timeout: 240_000 });

    const card = await page.locator('#console-output .math-card').first().textContent();
    expect(card, 'the echo must name the line the student actually ran')
      .toContain('display(Integral(x, x))');
  });
});
