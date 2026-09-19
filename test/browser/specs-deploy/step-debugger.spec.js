const { test, expect } = require('@playwright/test');

// The step-through debugger and its floating panel, against a real deploy.
//
// WHY THIS EXISTS. The panel is ~1,900 lines of stateful DOM and the recorder
// is a sys.settrace program running inside Pyodide, and between them they have
// no browser coverage of any kind — a grep of specs/ and specs-deploy/ for the
// debugger, the Variables tab or the pill returns nothing. What unit tests
// cannot show is the thing the feature IS: that pressing one control records a
// real program in a real browser and replays it with the right values. Three
// of the four real defects found in this plugin during review were found by
// RUNNING it, which is the argument for this file.
//
// It is also the check that makes trial mileage mean something. Without it,
// "we tried the debugger on the trial" means "somebody clicked it once".
//
// Anonymous and read-only, like every spec in this directory: it drives the
// blank embed and never signs in or writes.
//
// The generous timeouts are not padding. Pyodide boots from jsDelivr (~10 MB)
// on the first Run, so the first assertion is waiting on a real download. The
// recording itself is fast once it is up — measured at ~0.8 s for the program
// below on a local stack.

// Two runnable non-import lines are the panel's own availability rule
// (debugPanelAvailable), so a one-liner would correctly show no pill at all.
// Line numbers matter to the assertions, so they are written out explicitly:
//
//   1  total = 0
//   2  for i in range(4):
//   3      total = total + i
//   4  print("total", total)
const PROGRAM = [
  'total = 0',
  'for i in range(4):',
  '    total = total + i',
  'print("total", total)',
].join('\n');

const setCode = (page, src) => page.evaluate((s) => {
  document.querySelector('.ace_editor').env.editor.setValue(s, 1);
}, src);

const varsText = (page) => page.evaluate(() => {
  const v = document.querySelector('.tk-dbg-vars');
  return v && !v.hidden ? v.innerText.replace(/\s+/g, ' ').trim() : '';
});

test.describe('step-through debugger', () => {
  // playwright.deploy.config.js caps a test at 90 s ("be patient but not
  // silly"), which is BELOW the 180 s this spec allows for the first Pyodide
  // boot — so on a genuinely cold deploy the test would die on the test
  // timeout before its own assertion ever gave up, and report as a failure
  // rather than as the slow download it is. Raise it for this block only.
  //
  // Worth knowing: this is a repo-wide shape, not a quirk of this file, and
  // issue #302 is the sweep for it. Re-derived on feat/mpl-figures by reading
  // each file whole -- NOT per test, because matplotlib-figures.spec.js and
  // worker-figure-toolbar.spec.js keep their long wait in a runProgram() helper
  // outside any test() block, which a per-test parser silently clears:
  //
  //   raised:     step-debugger (180 s -> 240 s),
  //               panefit (240 s -> 360 s, two blocks at 660 s),
  //               panefit-plotstyle (240 s -> 420 s, one test at 660 s),
  //               worker-figsize-ratchet (240 s -> 660 s)
  //   NOT raised: math-output (180 s), matplotlib-figures (180 s),
  //               worker-figure-toolbar (180 s), console-status (120 s),
  //               deploy-smoke (120 s)
  //   marginal:   plotstyle.spec.js, largest wait exactly 90 s, i.e. the cap
  //
  // THE TABLE ABOVE IS specs-deploy ONLY, AND IT IS NOT THE WORST CASE. The
  // worst is in ../specs, the directory browser-smoke.yml actually runs:
  // worker-runtime.spec.js has 240 s assertions across 15 tests with NOTHING
  // raising the budget, and share-runtime-option.spec.js has three tests
  // exceeding via its runInEmbed helper. A green run of the CI-facing suite is
  // therefore saying less than it appears to. Both are in #302.
  //
  // Counting trap, which is why two independent sweeps disagreed: a per-`test(`
  // grep undercounts. matplotlib-figures.spec.js builds its tests in a
  // `for...of CASES` loop (:58-59), so it greps as one test and is four, all
  // four inheriting runProgram()'s 180 s wait.
  //
  // Those five have not hit it because nothing has been slow enough yet. That
  // is luck, not design. math-output.spec.js is fixed on feat/mathoutput-worker
  // (4a31d33) and still unfixed here, so expect these two branches to collide
  // on this paragraph; the list above is the one to keep.
  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/embed/python3');

    // Read the SERVED page rather than probing a JS object. math-output.spec.js
    // learned this the hard way: window.trinket.config is FLAT, and probing
    // window.trinket.config.features.mathOutput made that spec skip silently on
    // a deploy where the feature was demonstrably on. A test that skips when it
    // should run is worse than no test.
    const html = await page.content();
    const cfg = {
      vars:   /variableExplorer\s*:\s*true/.test(html),
      step:   /stepDebugger\s*:\s*true/.test(html),
      panel:  /debugPanel\s*:\s*true/.test(html),
      worker: /workerRuntime\s*:\s*true/.test(html),
    };

    // Say WHY out loud. A silent skip is indistinguishable from a pass in the
    // summary line.
    if (!cfg.step)  console.log('  [step-debugger] SKIP: features.stepDebugger is off on this deploy');
    else if (!cfg.panel) console.log('  [step-debugger] SKIP: stepDebugger is on but debugPanel is off — this spec drives the floating pill');
    else console.log('  [step-debugger] RUNNING: stepDebugger + debugPanel on');
    // Worth printing rather than skipping on: the recorder is always
    // main-thread, so it still works here — but on a worker deploy the page's
    // own Pyodide was never booted by the Run, so the first launch pays a full
    // second interpreter's start-up. If this spec is ever mysteriously slow on
    // one deploy and not another, that is why.
    if (cfg.worker) console.log('  [step-debugger] NOTE: worker deploy — the first launch boots a second, main-thread Pyodide');

    test.skip(!cfg.step,  'features.stepDebugger is off on this deploy');
    test.skip(!cfg.panel, 'features.debugPanel is off on this deploy');
    // stepDebugger requires variableExplorer; if that pairing is ever broken in
    // a deploy's config, fail loudly rather than skipping past it.
    expect(cfg.vars, 'stepDebugger requires variableExplorer').toBe(true);
  });

  test('records a program and replays it with the right values', async ({ page }) => {
    const pill = page.locator('.tk-dbg');

    // The pill appears only after a Run — before one there is nothing to step
    // through, and offering the control would be a lie.
    await expect(pill, 'no pill before the first Run').toBeHidden();

    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await setCode(page, PROGRAM);
    await page.locator('.run-it').first().click();

    // First Run downloads and boots Pyodide.
    await expect(page.locator('#console-output'), 'the program itself should run')
      .toContainText('total 6', { timeout: 180_000 });
    await expect(pill, 'the pill should appear once there is something to step through')
      .toBeVisible();

    // Opening the collapsed pill IS the request to record — there is no second
    // button to find afterwards.
    await pill.locator('[data-act="toggle"]').click();

    const controls = pill.locator('[data-grp="controls"]');
    await expect(controls, 'the recording should finish and hand over to replay')
      .toBeVisible({ timeout: 120_000 });
    await expect(pill.locator('[data-grp="launch"]')).toBeHidden();

    // The recording covers the whole program: 4 lines, a 4-pass loop, plus the
    // synthetic <end> step. Asserted as "more than the line count" rather than
    // an exact number, so an off-by-one in the recorder is caught without this
    // spec having to track the step model.
    const slider = pill.locator('[data-act="slider"]');
    await expect(slider).toHaveValue('0');
    const total = Number(await slider.getAttribute('max'));
    expect(total, 'a 4-pass loop should record more steps than it has lines').toBeGreaterThan(4);

    // The replay starts before anything has run.
    expect(await varsText(page)).toContain('About to execute line 1');

    // One step forward binds the first variable. This is the assertion that the
    // recorder captured VALUES and not just positions.
    await pill.locator('[data-act="fwd"]').click();
    await expect.poll(() => varsText(page), { timeout: 15_000 })
      .toContain('total = 0');

    // Jump to the end. The replay's final state has to agree with what the
    // program actually printed — total 6 is in the console above, and it is
    // the whole point of a replay that the two match.
    await pill.locator('[data-act="last"]').click();
    await expect.poll(() => varsText(page), { timeout: 15_000 })
      .toContain('total = 6');
    expect(await varsText(page)).toContain('i = 3');
    expect(await varsText(page)).toContain('Reached the end');

    // Leaving replay collapses the pill and drops the controls. The pill
    // itself stays, because the program is still steppable.
    //
    // Do NOT assert the launch group is *visible* here. Collapsing sets
    // display:none on .tk-dbg-body, which contains it — so the group's own
    // `hidden` attribute is false while the element renders not at all. An
    // earlier draft of this spec checked the attribute by hand, saw false,
    // and asserted visibility; Playwright caught it. What the student is
    // promised is that the pill collapses, the controls go, and the pill is
    // still there to reopen.
    await pill.locator('[data-act="exit"]').click();
    await expect(controls).toBeHidden();
    await expect(pill, 'exit should collapse the pill').not.toHaveClass(/\bopen\b/);
    await expect(pill).toBeVisible();
    // The launch control is the group that comes back on reopen, so assert it
    // is armed rather than rendered.
    await expect(pill.locator('[data-grp="launch"]')).not.toHaveAttribute('hidden', /.*/);
  });

  test('offers nothing to step through for a program too short to debug', async ({ page }) => {
    // debugPanelAvailable() requires two runnable non-import lines. A one-line
    // program is the common "I just want to print something" case, and the pill
    // must stay out of the way rather than offering a recording of one step.
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await setCode(page, 'print("hello")\n');
    await page.locator('.run-it').first().click();
    await expect(page.locator('#console-output')).toContainText('hello', { timeout: 180_000 });
    await expect(page.locator('.tk-dbg'), 'a one-line program is not worth stepping')
      .toBeHidden();
  });
});
