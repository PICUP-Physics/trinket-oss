const { test, expect } = require('@playwright/test');

// The dpi pane fit AND the plot-style panel, in the same page.
//
// They had never been run together until 2026-09-18, and the pairing is the
// item's whole justification: you need the plot on screen to style it. Each
// half is covered on its own -- panefit.spec.js and plotstyle.spec.js -- so
// everything here is about the INTERACTION, and each test fails for a reason
// that only exists when both are live:
//
//   * the panel's host element adding 18 px to a pane the fit has just filled,
//   * a style or a live-preview redraw taking back the figure's inches or the
//     density the fit chose,
//   * the panel's own re-run producing a figure that nothing fits.
//
// features.plotStyle is OFF in most configs, so every test skips loudly rather
// than passing vacuously. Bring the stack up with it on:
//   harness/integration-reset.sh --branch feat/mpl-figures --flag plotStyle=true

const PROG = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t), label="x(t)")',
  "plt.xlabel('time (s)'); plt.ylabel('displacement (m)'); plt.title('Damped'); plt.legend()",
  'plt.show()',
  'print("FINI")',
].join('\n');

// Read straight out of the live interpreter through the panel's own backend --
// the same bridge the panel styles with. Only the main thread has one: a worker
// run has no second Pyodide on the page to introspect with.
const PY_STATE = `
import matplotlib, json
import matplotlib.pyplot as plt
_f = plt.gcf()
json.dumps({
  "figsize": [round(v, 4) for v in _f.get_size_inches()],
  "fig_dpi": round(_f.dpi, 3),
  "rc_figsize": [round(v, 4) for v in matplotlib.rcParams["figure.figsize"]],
  "rc_savedpi": matplotlib.rcParams["savefig.dpi"],
  "font": matplotlib.rcParams["font.size"],
})
`;

async function skipUnlessPlotStyle(page) {
  const html = await (await page.goto('/embed/python3')).text();
  test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');
}

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
  await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(4000);           // the fit's round trip, then settle
  await page.locator('plotpolish-panel').waitFor({ state: 'attached', timeout: 60_000 });
}

function readProbe(page, py) {
  return page.evaluate(async (pySrc) => {
    const st = window.__trinketPaneFit.state();
    const one = st[Object.keys(st)[0]];
    const c = document.querySelector('#graphic canvas');
    const wrap = document.getElementById('graphic-wrap');
    const panel = document.querySelector('plotpolish-panel');
    let pyState = null;
    if (pySrc && panel && panel.backend) {
      try { pyState = JSON.parse(await panel.backend.runPython(pySrc)); }
      catch (e) { pyState = { error: String(e && e.message || e) }; }
    }
    return {
      probe: one,
      classified: window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`),
      canvas: { w: c.clientWidth, h: c.clientHeight },
      wrap: { scrollHeight: wrap.scrollHeight, clientHeight: wrap.clientHeight },
      panelDisplay: getComputedStyle(panel).display,
      panelLayout: panel.getAttribute('layout'),
      py: pyState,
      dpr: window.devicePixelRatio,
    };
  }, py || null);
}

test.describe('pane fit + plot style panel', () => {
  // See the long note in panefit.spec.js. Same defect, same reason: the config
  // that owns this directory caps a test at 90_000 while runFigure waits up to
  // 240_000.
  //
  // 420_000 for the block, and 660_000 raised on ONE test below. Only 'worker:
  // the panel re-run comes back fitted' runs the program twice -- runFigure's
  // 240 s wait, then another for the panel's own re-run -- so only that test can
  // serialize two long waits. A single 660 s block handed the other four 270 s
  // of headroom they cannot use and doubled their exposure to an unbounded step
  // (see below) from 6 minutes to 11, again under `retries: 1`.
  //
  // 420 and not 360. The budget has to exceed the SERIALIZED TOTAL, not the
  // largest single assertion -- that distinction is the whole point of splitting
  // and an earlier version of this comment got it wrong, shipping 360 while the
  // derivation that produced it printed 384-390:
  //
  //   runFigure HERE = 240 (console poll) + 60 (canvas attached)
  //                  + 60 (plotpolish-panel attached) + 4 (settle)
  //                  + 20 (the config's default expect, on .ace_editor)  = 384 s
  //   + 6 s of per-test settles in two of them                           = 390 s
  //
  // The extra 60 s is the `plotpolish-panel` waitFor, which panefit.spec.js's
  // runFigure does not have -- which is exactly why 360 is enough there and not
  // here. 420 clears 390 with 30 s of margin and still cuts four tests from 11
  // minutes to 7, which was the entire point.
  //
  // This is NOT "lower the block and leave long assertions in it", the mistake
  // refuted by measurement on feat/mathoutput-worker: the test with two long
  // waits keeps the full 660 s.
  test.describe.configure({ timeout: 420_000 });

  // 1700x760 is deliberate: it is a shape where HEIGHT binds, so the fit gives
  // the figure the whole pane and there is no slack left to absorb anything.
  for (const [label, query] of [['worker', '?runtime=worker'], ['main', '?runtime=main']]) {
    test(`${label}: the panel does not push the fitted figure out of the pane`, async ({ page }) => {
      await skipUnlessPlotStyle(page);
      await runFigure(page, query, { width: 1700, height: 760 });
      const got = await readProbe(page);

      // The panel draws in a fixed-position layer and leaves its host at 0x0,
      // but the host is `display: inline-flex` -- an inline box on a line of
      // its own after #graphic, whose line box takes the wrap's 18 px strut.
      // Harmless while the figure left slack; with the fit filling the pane
      // exactly it was the only thing that did not fit, and the output pane
      // became scrollable by exactly 18 px (measured 489 against 471 on both
      // runtimes, before the adapter's host rule).
      //
      // The overflow itself is asserted FIRST and the mechanism second: under
      // mutation (the host rule put back to inline-flex) a display check ahead
      // of it short-circuits the test, so the assertion that names the actual
      // symptom would never have been exercised.
      expect(got.wrap.scrollHeight,
        `pane overflows by ${got.wrap.scrollHeight - got.wrap.clientHeight}px with the panel mounted`)
        .toBeLessThanOrEqual(got.wrap.clientHeight + 1);
      expect(got.panelLayout, 'the panel is in its floating layout').toBe('float');
      expect(got.panelDisplay, 'the host generates no line box').toBe('block');

      // And the fit itself is unchanged by the panel's presence: one startup,
      // one echo, nothing classified as a drag, and the figure inside the box.
      const kinds = got.classified.map(s => s.split(':')[0]);
      expect(kinds.filter(k => k === 'drag'), `no drags: ${got.classified}`).toHaveLength(0);
      expect(got.canvas.h, 'figure fits the pane').toBeLessThanOrEqual(got.probe.box.h + 1);
      expect(got.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
    });
  }

  test('main: a live-preview redraw leaves the fit alone', async ({ page }) => {
    await skipUnlessPlotStyle(page);
    await runFigure(page, '?runtime=main', { width: 1280, height: 900 });
    const before = await readProbe(page, PY_STATE);
    expect(before.py, 'the panel has a live backend on the main thread').not.toHaveProperty('error');

    // A student-facing control, driven the way the panel's own UI drives it.
    const moved = await page.evaluate(() => {
      const sr = document.querySelector('plotpolish-panel').shadowRoot;
      const tab = [...sr.querySelectorAll('button.tab')].find(b => b.textContent.trim().startsWith('Text'));
      if (tab) tab.click();
      const el = sr.querySelector('#ctl-font_size');
      if (!el) return false;
      el.value = '18';
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return true;
    });
    expect(moved, 'the Text tab offers a font-size control').toBe(true);
    await page.waitForTimeout(6000);
    const after = await readProbe(page, PY_STATE);

    // Vacuity guard first: if the preview did not actually redraw anything,
    // everything below passes for the wrong reason.
    expect(after.py.font, 'the live preview applied the change').toBe(18);

    // The figure is the same figure, at the same density, in the same box. A
    // preview redraw that went through matplotlib's own defaults would put
    // fig.dpi back to 100 and leave the figure small in a large pane.
    expect(after.py.figsize, 'figsize is untouched by the preview').toEqual(before.py.figsize);
    expect(after.py.fig_dpi, 'the fitted density survives the redraw').toBe(before.py.fig_dpi);
    expect(after.canvas, 'the canvas does not move').toEqual(before.canvas);

    // And it provoked no fit: a redraw is not a resize.
    expect(after.classified, 'a preview redraw is not a resize').toEqual(before.classified);
    expect(after.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
  });

  test('main: picking a style keeps the shape the host owns', async ({ page }) => {
    await skipUnlessPlotStyle(page);
    await runFigure(page, '?runtime=main', { width: 1280, height: 900 });
    const before = await readProbe(page, PY_STATE);

    // seaborn-v0_8 is one of the curated buttons AND one of the 8 styles that
    // set figure.figsize -- 8 x 5.5, which would change both the exported shape
    // and what the pane fit is fitting.
    const picked = await page.evaluate(() => {
      const sr = document.querySelector('plotpolish-panel').shadowRoot;
      const tab = [...sr.querySelectorAll('button.tab')].find(b => b.textContent.trim().startsWith('Look'));
      if (tab) tab.click();
      const th = [...sr.querySelectorAll('button.style-thumb')]
        .find(b => (b.getAttribute('title') || '') === 'seaborn-v0_8');
      if (!th) return false;
      th.click();
      return true;
    });
    expect(picked, 'the Look tab offers the seaborn-v0_8 style').toBe(true);
    await page.waitForTimeout(6000);

    // The generated block is where the protection lives from the next run on:
    // it saves the three keys this host sets, applies the style, and puts them
    // back. Without figure.figsize in that list, picking seaborn silently
    // rewrote 4.8 x 3.6 to 8 x 5.5; without savefig.dpi, `classic` dropped a
    // 300-dpi export to 100.
    const src = await page.evaluate(() => document.querySelector('.ace_editor').env.editor.getValue());
    expect(src, 'the block reached the editor').toContain('mpl.style.use("seaborn-v0_8")');
    for (const key of ['figure.autolayout', 'figure.figsize', 'savefig.dpi']) {
      expect(src, `the block preserves ${key}`).toContain(`"${key}"`);
    }
    expect(src, 'the preserved values are restored after the style').toMatch(
      /mpl\.style\.use\([^)]*\)\s*\n\s*mpl\.rcParams\.update\(_plotpolish_host_rc\)/);

    // And the live figure did not move under the student while they picked.
    const after = await readProbe(page, PY_STATE);
    expect(after.py.figsize, 'figsize is untouched by the style').toEqual(before.py.figsize);
    expect(after.py.fig_dpi, 'the fitted density survives the style').toBe(before.py.fig_dpi);
    expect(after.canvas, 'the canvas does not move').toEqual(before.canvas);
  });

  test('worker: the panel re-run comes back fitted', async ({ page }) => {
    // The only test here that runs the program twice; see the block note above.
    test.setTimeout(660_000);
    await skipUnlessPlotStyle(page);
    await runFigure(page, '?runtime=worker', { width: 1280, height: 900 });
    const before = await readProbe(page);

    // Nothing previews on the worker -- there is no second interpreter on the
    // page -- so the panel's notice becomes a button and asks the host to run.
    // The whole style path there ends in a re-run, and a re-run builds a NEW
    // figure: if it were not fitted, every worker student's styling round trip
    // would end at matplotlib's default density in a pane three times the size.
    // With a change PENDING, because that is the only state the button exists
    // to serve -- and it is what a worker student's styling round trip actually
    // looks like: move a control, see "Re-run to update plot.", press it.
    const clicked = await page.evaluate(() => {
      const sr = document.querySelector('plotpolish-panel').shadowRoot;
      const tab = [...sr.querySelectorAll('button.tab')].find(b => b.textContent.trim().startsWith('Text'));
      if (tab) tab.click();
      const ctl = sr.querySelector('#ctl-font_size');
      if (!ctl) return 'no font control';
      ctl.value = '18';
      ctl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      ctl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const b = [...sr.querySelectorAll('button')].find(x => /re-?run/i.test(x.textContent));
      if (!b) return 'no re-run button';
      b.click();
      return 'ok';
    });
    expect(clicked, 'a pending change and a re-run button on the worker').toBe('ok');

    // NOT by watching the console: it is cleared at the start of every run, so
    // the completion marker never appears twice however well the button works.
    // The classifier's own log is the honest witness -- a second run registers
    // its own startup resize and its echo.
    await expect.poll(async () => page.evaluate(() => window.__trinketPaneFit.classified.length),
      { timeout: 240_000 }).toBeGreaterThan(before.classified.length);
    await page.waitForTimeout(4000);
    const after = await readProbe(page);

    expect(after.classified.filter(s => s.startsWith('startup')).length,
      `the re-run's figure registered its own startup: ${after.classified}`).toBeGreaterThan(1);
    expect(after.canvas, 'the re-run figure is fitted the same way').toEqual(before.canvas);
    expect(after.canvas.w, 'the re-run figure fits the pane')
      .toBeLessThanOrEqual(after.probe.box.w + 1);
    expect(after.probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
  });
});
