const { test, expect } = require('@playwright/test');

// The dpi pane fit: the figure is fitted to the output pane by scaling
// figure.dpi with figsize FIXED, so the picture is the same composition at a
// different scale and the download never depends on the browser window.
//
// These read window.__trinketPaneFit, the probe pyodide.js exposes for them.
// That matters: the failures this guards against look FINE in a screenshot.
// figsize drifting a few hundredths of an inch per fit, or a classifier calling
// a student's drag an echo, are invisible until someone downloads a file or
// resizes twice -- so the assertions are on the classifier's own decisions and
// on Python's numbers, not on pixels alone.
//
// Both runtimes, because they diverge: the worker's round trip is asynchronous
// and its toolbar carries Font Awesome glyphs, while the main thread's is
// synchronous with matplotlib's own PNG icons. Every bug below appeared on one
// and not the other.
//
// dpr is whatever the browser gives. Playwright's emulated deviceScaleFactor
// does NOT drive devicePixelContentBoxSize, so a dpr-2 run means a HEADED
// Chrome on a retina panel -- the assertions here are written to hold at any
// density rather than to pin one.

// THE ENCLOSING TEST BUDGET. `playwright.deploy.config.js` -- the config that
// owns this directory -- caps a test at 90_000, and every `runFigure` here waits
// up to 240_000 for the program to finish. Without this line the TEST dies at
// 90 s and a cold Pyodide download is reported as "the figure never appeared":
// the assertion that names what a student did not see never gets to run.
//
// Never measured here, and said plainly: this suite passes under the 90 s cap on
// a warm local stack in 2.8 minutes, slowest test 23.9 s, and a deliberate 20 s
// cap did not kill it either. localhost serves Pyodide from cache. The 240 s
// waits exist for the REMOTE baseURL this config actually defaults to, on a cold
// server, which is the case no run on this machine can produce.
//
// 360_000 and not 240_000: the value has to EXCEED the largest assertion timeout
// in the tests it covers, not equal it. At an equal budget the test cap fires at
// the same instant and you get "Test timeout of 240000ms exceeded" instead of
// the message naming the symptom -- the same defect in weak form.
//
// Two blocks below raise it further because they run the program TWICE, so two
// 240 s waits can serialize inside one test. Lowering either of those back to
// this value would put them exactly where this line found them.
//
// Cost: `retries: 1` makes a genuine failure cost 2x the budget. That is the
// right trade for a suite no workflow runs (#293). Repo-wide version is #302;
// the same fix landed on feat/mathoutput-worker in 4a31d33.
test.describe.configure({ timeout: 360_000 });

const PROG = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t))',
  "plt.xlabel('time (s)'); plt.ylabel('displacement (m)'); plt.title('Damped')",
  'plt.show()',
  'print("FINI")',
].join('\n');

const RUNTIMES = [['worker', '?runtime=worker'], ['main', '?runtime=main']];

async function runFigure(page, query, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/embed/python3' + query);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, PROG);
  await page.locator('.run-it').first().click();
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('#console-output')?.innerText || ''),
    { timeout: 240_000 }).toContain('FINI');
  // The canvas mpl.js creates, not #graphic -- that is in the page's own HTML
  // and is attached before the program has even run.
  await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(4000);           // the fit's round trip, then settle
}

function readProbe(page) {
  return page.evaluate(() => {
    const st = window.__trinketPaneFit.state();
    const one = st[Object.keys(st)[0]];
    const tb = document.querySelector('#graphic .mpl-toolbar');
    const sel = tb && tb.querySelector('select.mpl-widget');
    const btn = tb && tb.querySelector('button.mpl-widget');
    const c = document.querySelector('#graphic canvas');
    const div = c.parentNode;
    return {
      probe: one,
      classified: window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`),
      canvas: { w: c.clientWidth, h: c.clientHeight },
      div: { w: parseFloat(div.style.width) || c.clientWidth },
      toolbar: {
        height: tb && tb.offsetHeight,
        selectWidth: sel && sel.offsetWidth,
        selectHeight: sel && sel.offsetHeight,
        selectRadius: sel && getComputedStyle(sel).borderRadius,
        buttonHeight: btn && btn.offsetHeight,
        topsAlign: btn && sel
          ? Math.abs(btn.getBoundingClientRect().top - sel.getBoundingClientRect().top) <= 1
          : null,
      },
      overrideInjected: !!document.getElementById('trinket-mpl-toolbar-css'),
      dpr: window.devicePixelRatio,
    };
  });
}

test.describe('pane fit: startup', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: the first fit lands once and agrees with the canvas`, async ({ page }) => {
      await runFigure(page, query, { width: 1280, height: 900 });
      const got = await readProbe(page);
      const kinds = got.classified.map(s => s.split(':')[0]);

      // mpl.js's own startup resize is classified as such, once, and the first
      // fit is issued FROM it -- which is after socket.onopen has carried the
      // device pixel ratio to Python. Issuing it at registration instead made
      // manager.resize divide by a ratio still at 1, sizing the div in DEVICE
      // pixels: at dpr 2 that recomputed figsize as 9.82x7.37in and overflowed
      // every pane. It did not show at every window size, nor on main, whose
      // synchronous round trip coalesces the two resizes.
      //
      // THERE IS DELIBERATELY NO ASSERTION ON THE STARTUP-NOTE COUNT. This used
      // to be `toHaveLength(1)`, and c0f671c made that false:
      // paneFitNote('startup') sits ABOVE the coalescing block
      // (pyodide.js:4030), so every delivery in a boot burst is noted, and the
      // point of that commit is that the burst is not always one delivery. So
      // the old assertion went red on exactly the load the fix exists for,
      // while a REVERT goes red on the `drag` assertion below -- a flake
      // detector that punished the fixed behaviour.
      //
      // Weakening it to `toBeGreaterThanOrEqual(1)` was the first repair and it
      // was a tautology: `awaitStartup = false` is written at exactly one place
      // (pyodide.js:4115), inside the rAF callback, which is only ever scheduled
      // from the branch whose first statement IS paneFitNote('startup'). So
      // awaitStartup === false implies at least one startup note, and that is
      // asserted below.
      //
      // Two overstatements in that argument, corrected by round 9 without
      // changing its conclusion. "No mutation could turn the weakened line red"
      // is false: deleting paneFitNote('startup') would. It is caught anyway,
      // by the second-run test at :297 -- which is the 660 s two-run one, so if
      // that test is ever skipped the mutation goes invisible. And the 40-entry
      // log-cap reasoning was backwards: every burst delivery IS a startup
      // note, so 40+ deliveries give 40 startup notes rather than none; evicting
      // the first would need 40 consecutive NON-startup entries, which is
      // unreachable.
      //
      // The invariants that survived c0f671c are the two below: no delivery is
      // misread as a drag, and the startup marker is consumed.

      // Nobody dragged anything, so nothing may be classified as a drag. A drag
      // is what recomputes figsize, and a misclassified one is the ratchet.
      expect(kinds.filter(k => k === 'drag'), `no drags: ${got.classified}`).toHaveLength(0);

      // The div sized in device pixels was the doubling bug's signature.
      expect(Math.abs(got.div.w - got.canvas.w),
        `div ${got.div.w} vs canvas ${got.canvas.w} at dpr ${got.dpr}`).toBeLessThanOrEqual(1);

      // And it still fits. The bug overflowed by 227x171.
      expect(got.canvas.w, 'figure fits the pane').toBeLessThanOrEqual(got.probe.box.w + 1);

      // Bounded, NOT drained: an echo is not guaranteed. If the size Python
      // asks for is the size the div already has, the browser delivers no
      // ResizeObserver callback and nothing decrements the count.
      expect(got.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
      expect(got.probe.awaitStartup, 'the startup resize was consumed').toBe(false);


      // Redundant fits are dropped at source rather than counted, so the bound
      // holds however many arrive.
      const after = await page.evaluate(async () => {
        for (let i = 0; i < 10; i++) window.__trinketPaneFit.fit();
        await new Promise(r => setTimeout(r, 1500));
        const st = window.__trinketPaneFit.state();
        return st[Object.keys(st)[0]].pendingFits;
      });
      expect(after, 'redundant fits are skipped, not counted').toBeLessThanOrEqual(2);
    });
  }
});

test.describe('pane fit: the figure gets the whole pane', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: toolbar is one row and the dropdown matches the buttons`, async ({ page }) => {
      // A big window. The comment here used to say HEIGHT binds at this size,
      // and that was true before the Foundation fix gave every figure 54px of
      // height back: measured now at 1920x1080, WIDTH binds on both runtimes --
      // canvas 775x581 in a 775x597 box on the worker and 775x593 on main, i.e.
      // 100% of the width and 97-98% of the height. Copilot read the stale
      // comment and reported the 90%-of-width assertion below as a false
      // failure waiting to happen; the comment was wrong, the assertion is not.
      // Height still binds at shapes like 1700x760, which is where the vertical
      // assertions live.
      await runFigure(page, query, { width: 1920, height: 1080 });
      const got = await readProbe(page);
      const tb = got.toolbar;

      // Foundation styles bare `select { width: 100% }`, which stretched
      // mpl.js's format dropdown across the whole toolbar so it could not share
      // a line with the buttons at any pane size: 109px of toolbar where
      // matplotlib intends about 55, costing every figure 54px of height.
      expect(got.overrideInjected, 'the Foundation override is injected').toBe(true);
      expect(tb.selectWidth, 'the dropdown is its natural width, not 100%')
        .toBeLessThan(got.probe.box.w / 2);

      // Height, not row count: distinct offsetTop values do NOT mean distinct
      // lines for inline-block children of different heights -- they sit on one
      // line at different baselines, which is the passing state.
      expect(tb.height, 'toolbar is one row tall').toBeLessThanOrEqual(70);
      expect(got.probe.chrome, 'chrome is the title bar plus one toolbar row').toBeLessThan(100);

      // Sitting beside the buttons, it has to look like one. Read off a real
      // button rather than written down: the worker's are 34px (Font Awesome)
      // and the main thread's 38px (matplotlib's PNGs), so no constant fits both.
      expect(tb.selectHeight, 'dropdown is button height').toBe(tb.buttonHeight);
      expect(tb.selectRadius, 'dropdown is not boxy').not.toBe('0px');
      expect(tb.topsAlign, 'dropdown and buttons share a baseline').toBe(true);

      // The point of all of it: one fit, and the figure uses the pane.
      expect(got.classified.filter(k => k.startsWith('echo')),
        `startup settles in one fit: ${got.classified}`).toHaveLength(1);
      expect(got.canvas.w, 'figure fills the available width')
        .toBeGreaterThan(got.probe.box.w * 0.9);
    });
  }
});

// A student's second Run of the same program. Everything above runs the program
// ONCE per page, which is what let this through: figure ids are reused (Pyodide
// numbers the main thread's figures from 1 every run, the worker calls its
// figure 'fig1'), so registration used to find the previous run's state and
// return, leaving every fit addressed to a detached figure on a dead socket.
//
// Measured on the main thread at dpr 2 before the fix: run twice, narrow the
// window, and the figure stayed 480px inside a 398px pane with NOTHING in the
// classifier log; a corner drag on the new figure was then classified as an
// echo, because the pointerdown listener sat on a div no longer in the
// document. The worker was unaffected -- it tore its state down per run -- so
// this needs both runtimes to be worth anything.
test.describe('pane fit: the second run', () => {
  // Runs the program twice: two 240 s waits can serialize in one test, so the
  // file-level 360_000 above is not enough here.
  test.describe.configure({ timeout: 660_000 });

  for (const [label, query] of RUNTIMES) {
    test(`${label}: a re-run's figure is the one that gets fitted`, async ({ page }) => {
      await runFigure(page, query, { width: 1600, height: 900 });
      const first = await readProbe(page);

      // Mark the first run's canvas, then wait for a canvas that is not it.
      // NOT the console: it is cleared at the start of every run, so the
      // completion marker cannot appear twice -- and not the classifier log
      // either, because under the bug nothing is ever logged, which would fail
      // this as a timeout instead of as the assertion that names the symptom.
      await page.evaluate(() => {
        document.querySelector('#graphic canvas').dataset.trinketPrevRun = '1';
      });
      await page.locator('.run-it').first().click();
      await expect.poll(async () => page.evaluate(() => {
        const c = document.querySelector('#graphic canvas');
        return !!c && c.dataset.trinketPrevRun !== '1';
      }), { timeout: 240_000 }).toBe(true);
      await page.waitForTimeout(4000);

      const second = await readProbe(page);

      // SYMPTOM FIRST, mechanism second -- the ordering discipline this file's
      // sibling already follows. Under the double mutation (both halves of the
      // fix reverted) the mechanism assertion fails first and short-circuits the
      // test, so the assertion that names what a student sees never runs.
      //
      // What a student sees: narrow the window and the figure follows. 1200
      // keeps the side-by-side layout (below about 1100 the output pane becomes
      // tabbed, which is a different test).
      await page.setViewportSize({ width: 1200, height: 900 });
      await expect.poll(async () => {
        const got = await readProbe(page);
        return got.canvas.w <= got.probe.box.w + 1;
      }, { timeout: 30_000, message: 'the re-run figure never fitted the narrowed pane' }).toBe(true);

      const after = await readProbe(page);
      expect(after.canvas.w, `figure ${after.canvas.w} in a ${after.probe.box.w} pane`)
        .toBeLessThanOrEqual(after.probe.box.w + 1);
      expect(after.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);

      // The mechanism behind it: the new figure registered, rather than
      // inheriting the old figure's state and returning at the guard.
      //
      // Known and deliberate: this test is green with EITHER half of the fix
      // reverted -- the identity check in registerPaneFit and the
      // resetMplFigures() call in startRun each fix the re-run on their own, and
      // only reverting both fails it. So a future refactor can delete one half
      // and the suite stays quiet. Keeping both is a belt-and-braces call, not
      // an accident.
      expect(second.classified.filter(s => s.startsWith('startup')).length,
        `a startup per run: ${second.classified}`).toBeGreaterThan(
        first.classified.filter(s => s.startsWith('startup')).length);
    });
  }
});

// The refit budget, pinned with the oscillator a local review used to break the
// first version of it. The claim that failed was "bounded by paneFit's own
// box-signature check": lastBoxSig remembers exactly ONE previous box, so it
// rules out a fixed point and not a 2-cycle, and a chrome term that depends on
// the canvas width made the figure flip between 513 and 481 px forever -- 25 log
// entries in the first second, each one a real resize and a full Agg render.
//
// Nothing in the shipped page oscillates: chrome is a constant 82 (worker) / 86
// (main) from a 900 px figure down to a 160 px one. This test injects the
// oscillator deliberately, because the bound has to be structural rather than a
// property of today's CSS.
test.describe('pane fit: the refit budget', () => {
  test('main: a chrome oscillator settles instead of running forever', async ({ page }) => {
    await runFigure(page, '?runtime=main', { width: 1700, height: 760 });

    // Before anything is injected: the figure fits the pane VERTICALLY. This is
    // the only unconditional height-bound assertion in the suite -- every other
    // one in this file is width-bound, and the one in panefit-plotstyle.spec.js
    // sits behind a plotStyle skip, so on an ordinary deploy nothing else checks
    // that subtracting chrome actually works. 1700x760 is a shape where height
    // binds. The worker at a height-bound shape stays uncovered without
    // plotStyle: a stated gap, not an oversight.
    const fitted = await readProbe(page);
    expect(fitted.canvas.h, 'figure fits the pane')
      .toBeLessThanOrEqual(fitted.probe.box.h + 1);

    // A chrome term that grows when the figure is wide and shrinks when it is
    // narrow -- the shape of a toolbar that wraps, which is what the original
    // bound was argued from.
    await page.evaluate(() => {
      const canvas = document.querySelector('#graphic canvas');
      const root = canvas.closest('div').parentNode;
      const spacer = document.createElement('div');
      spacer.style.height = '0px';
      root.appendChild(spacer);
      const threshold = canvas.clientWidth - 16;
      new ResizeObserver(() => {
        spacer.style.height = (canvas.clientWidth > threshold) ? '24px' : '0px';
      }).observe(canvas);
      spacer.style.height = '24px';
      window.__trinketPaneFit.fit();
    });

    // The newest entry's TIMESTAMP, not the log's length: the log is capped at
    // 40 entries, so under a real loop the length stops growing and a
    // length-to-length comparison passes while the figure flips forever. That
    // exact proxy passed under mutation here before this was rewritten.
    const newest = () => page.evaluate(() => {
      const log = window.__trinketPaneFit.classified;
      return log.length ? log[log.length - 1].t : 0;
    });
    await page.waitForTimeout(6000);
    const settled = await newest();
    await page.waitForTimeout(6000);
    const later = await newest();
    const log = await page.evaluate(() =>
      window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`));

    // VACUITY GUARD FIRST. Without it this test is green when the oscillator
    // never bites -- a detached spacer, a changed DOM shape, or the re-measure
    // removed entirely -- because "no new entries" and "no chrome notes" both
    // read as success. Verified: disconnecting the spacer passed both
    // assertions below in 21 seconds while proving nothing.
    const probe = await readProbe(page);
    expect(log.filter(s => s.startsWith('chrome')).length,
      `the oscillator never bit: ${log.join(' ')}`).toBeGreaterThan(0);

    expect(later - settled, `still refitting after 12s: ${log.join(' ')}`).toBe(0);

    // Two refits per box, read off the counter rather than counted in a log the
    // 40-entry cap can evict. "Per box" means refilled by any fit that is not
    // itself a chrome refit: refilling wherever the box signature is updated
    // refills the budget a chrome refit is spending, and the runaway returns.
    // BOTH, deliberately. The counter cannot exceed 2 by construction -- its
    // only increment is guarded by the same comparison -- so reading it is a
    // statement about the code's shape, not a detector. The log count IS
    // falsifiable: round 2's literal per-box reset put ~20 `chrome` entries in
    // it. Swapping one for the other traded a working detector for a
    // tautology, which the commit message wrongly called an improvement.
    expect(log.filter(s => s.startsWith('chrome')).length,
      `chrome refits in the log: ${log.join(' ')}`).toBeLessThanOrEqual(2);
    expect(probe.probe.chromeRefits, 'the refit budget is spent, not exceeded')
      .toBeLessThanOrEqual(2);
  });
});

// Two figures, because every other test in this file draws one -- which is how
// `Object.keys(paneFitState).forEach(paneFit)` survived review twice. forEach
// calls back with (value, index, array), so the index landed in
// `fromChromeRefit`: index 0 is falsy, every later index is truthy, and figures
// 2..n were treated as chrome refits by the two callers whose whole job is to
// refill the budget. Measured before the fix: after a window resize figure 1's
// counter went back to 0 and figure 2's stayed at 2, spent for the life of the
// page, with which figure was protected decided by Object.keys insertion order.
const TWO_FIGURES = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.figure()',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t))',
  'plt.figure()',
  'plt.plot(t, np.sin(t))',
  'plt.show()',
  'print("FINI")',
].join('\n');

test.describe('pane fit: more than one figure', () => {
  test('main: every figure refills its refit budget, not just the first', async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 760 });
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor').first()).toBeVisible();
    await page.evaluate((s) => {
      document.querySelector('.ace_editor').env.editor.setValue(s, 1);
    }, TWO_FIGURES);
    await page.locator('.run-it').first().click();
    await expect.poll(async () => page.evaluate(() =>
      document.querySelector('#console-output')?.textContent || ''),
      { timeout: 240_000 }).toContain('FINI');
    // Two FIGURES, counted in the fit's own state -- not two canvases. mpl.js
    // builds two per figure (the image and the rubberband overlay), so
    // `#graphic canvas` is 4 here and counting it asserts the wrong thing.
    await expect.poll(async () => page.evaluate(() =>
      Object.keys(window.__trinketPaneFit.state()).length), { timeout: 60_000 }).toBe(2);
    await page.waitForTimeout(4000);

    const budgets = () => page.evaluate(() => {
      const st = window.__trinketPaneFit.state();
      return Object.keys(st).map(id => ({ id: id, refits: st[id].chromeRefits }));
    });
    expect((await budgets()).length, 'both figures registered').toBe(2);

    // Spend both budgets with the oscillator from the budget test, one per
    // figure, then give both a new box.
    await page.evaluate(() => {
      // One per FIGURE: the first canvas inside each figure root, skipping the
      // rubberband overlay beside it.
      [...document.getElementById('graphic').children].forEach((root) => {
        const canvas = root.querySelector('canvas');
        if (!canvas) return;
        const spacer = document.createElement('div');
        spacer.style.height = '0px';
        root.appendChild(spacer);
        const threshold = canvas.clientWidth - 16;
        new ResizeObserver(() => {
          spacer.style.height = (canvas.clientWidth > threshold) ? '24px' : '0px';
        }).observe(canvas);
        spacer.style.height = '24px';
      });
      window.__trinketPaneFit.fit();
    });
    await page.waitForTimeout(6000);

    // Vacuity guard: if the oscillator did not bite on BOTH figures, the refill
    // assertion below is about nothing.
    const spent = await budgets();
    for (const fig of spent) {
      expect(fig.refits, `figure ${fig.id} never spent its budget: ${JSON.stringify(spent)}`).toBe(2);
    }

    await page.setViewportSize({ width: 1480, height: 850 });
    await page.waitForTimeout(5000);

    const after = await budgets();
    for (const fig of after) {
      expect(fig.refits, `figure ${fig.id} did not refill: ${JSON.stringify(after)}`)
        .toBeLessThan(2);
    }
  });
});

// `Clear memory`, then run again, then press Home. Copilot found this on fork
// PR #8 and it reproduced first try: the setup block's guards live on the
// matplotlib CLASSES and survive a namespace reset, while the helper names the
// wrappers resolved lived in Pyodide's globals and did not. So after a clear the
// patched methods were still installed and their dependencies were gone:
//
//   NameError: name '_nav_update_view' is not defined
//
// raised inside `home()`, with the figure's Home button silently doing nothing.
// It reaches the page as an unhandled error rather than the console, which is
// why this test listens for pageerror instead of reading #console-output.
//
// Every wrapper now binds what it needs as a default argument, so this covers
// the tight-layout patch, the nav restore, the resize echo guard and the save
// dpi normalisation together -- they all had the same shape.
test.describe('pane fit: after Clear memory', () => {
  // Runs the program twice: two 240 s waits can serialize in one test, so the
  // file-level 360_000 above is not enough here.
  test.describe.configure({ timeout: 660_000 });

  test('main: the figure toolbar still works on the next run', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await runFigure(page, '?runtime=main', { width: 1400, height: 900 });

    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('a,button')]
        .find(e => /clear memory/i.test(e.textContent || ''));
      if (!el) return false;
      el.click();
      return true;
    });
    expect(clicked, 'the embed offers a Clear memory control').toBe(true);
    await page.waitForTimeout(2500);

    // Re-run by the embed's own event rather than the Run control: at narrow
    // widths that control is a split button whose click opens a menu.
    await page.evaluate(() => { $('#editor').trigger('trinket.code.run', { action: 'code.run' }); });
    await expect.poll(async () => page.evaluate(() =>
      (document.querySelector('#console-output')?.textContent || '').includes('FINI')),
      { timeout: 240_000 }).toBe(true);
    await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
    await page.waitForTimeout(4000);

    // FOUR wrappers were rebound, and pressing Home exercises exactly one of
    // them. Reverting each binding separately and re-running showed the other
    // three breaking in ways this test could not see -- the tight-layout one
    // worst of all, since it raises inside every Figure.draw rather than on a
    // button. So: Home, then a corner drag (the resize wrapper, and a draw,
    // which is what reaches the layout engine), then Download (the save
    // wrapper). All three surface a Python failure the same way, through
    // webagg's on_message handler, as an unhandled page error.
    //
    // The fifth binding, `_dpi=_trinket_savefig_dpi`, is deliberately NOT
    // pinned: that helper is defined OUTSIDE the `_trinket_savedpi_patched`
    // guard, so it is redefined on every setup run and survives a clear for
    // free. The other four live inside guarded blocks that the second run
    // skips, which is precisely why they needed binding.
    const pressed = await page.evaluate(() => {
      const b = document.querySelector('#graphic button[title*="Reset"], #graphic .mpl-toolbar button');
      if (!b) return null;
      b.click();
      return b.title || '(untitled)';
    });
    // Asserted, not assumed: the fallback selector is "the first toolbar
    // button", which is Home only because matplotlib happens to order it first.
    // Without this the test could press Pan and assert nothing.
    expect(pressed, 'pressed Home').toContain('Reset');
    await page.waitForTimeout(2000);

    // A real corner drag. It has to be SLOW -- a hold, then small steps -- or
    // the native resizer never engages and the test measures nothing: a first
    // attempt with four fast steps produced zero `drag` entries in the
    // classifier log and looked like a pass.
    const corner = await page.evaluate(() => {
      const r = document.querySelector('#graphic canvas').parentNode.getBoundingClientRect();
      return { x: Math.round(r.right - 5), y: Math.round(r.bottom - 5) };
    });
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.waitForTimeout(150);
    for (let k = 1; k <= 6; k++) {
      await page.mouse.move(corner.x - 4 * k, corner.y - 3 * k);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => window.__trinketPaneFit.classified.some(e => e.kind === 'drag')),
      'the corner drag landed').toBe(true);

    // Download. The wrapper normalises savefig.dpi for the duration of the
    // call and puts it back; it calls through to the wheel's own handle_save
    // on every path, so a plain Download exercises it.
    const saved = await page.evaluate(() => {
      const b = document.querySelector('#graphic button[title*="Download"]');
      if (!b) return false;
      b.click();
      return true;
    });
    expect(saved, 'the figure has a Download button').toBe(true);
    await page.waitForTimeout(2500);

    expect(pageErrors.filter(m => /NameError/.test(m)),
      `Python raised into the page: ${pageErrors.join(' | ')}`).toHaveLength(0);
  });
});

// A gesture the browser abandons. `pointercancel` is what a touch device sends
// when scrolling takes over mid-drag, and there is no `pointerup` behind it: the
// classifier's pointerDown flag stayed true for the life of the figure and every
// later fit was deferred and never sent, so the figure stopped following the
// pane silently -- a deferred fit logs nothing.
//
// Synthetic PointerEvents are enough here because the flag is set and cleared by
// listeners, not by the native resizer: what is under test is the teardown, not
// a real drag.
test.describe('pane fit: a cancelled gesture', () => {
  for (const [label, query] of RUNTIMES) {
    test(`${label}: a cancelled pointer does not strand the figure`, async ({ page }) => {
      await runFigure(page, query, { width: 1500, height: 760 });

      await page.evaluate(() => {
        const div = document.querySelector('#graphic canvas').parentNode;
        const opts = { bubbles: true, composed: true, pointerId: 1, pointerType: 'touch', isPrimary: true };
        div.dispatchEvent(new PointerEvent('pointerdown', opts));
        div.dispatchEvent(new PointerEvent('pointercancel', opts));
      });
      await page.waitForTimeout(300);

      // The symptom first, the mechanism after -- this file's rule. With the
      // flag stranded this fit is deferred and never sent, and the figure
      // overflows its pane by the whole difference: measured 562x421 in a
      // 460x385 box on both runtimes. Checking pointerDown first would
      // short-circuit the test and never assert what a student sees.
      await page.setViewportSize({ width: 1150, height: 760 });
      await page.waitForTimeout(4000);

      const got = await readProbe(page);
      expect(got.canvas.w, `figure ${got.canvas.w} in a ${got.probe.box.w} pane`)
        .toBeLessThanOrEqual(got.probe.box.w + 1);
      expect(got.probe.deferred, 'no fit is left deferred').toBe(false);
      expect(got.probe.pointerDown, 'the cancel cleared the gesture').toBe(false);
    });
  }
});
