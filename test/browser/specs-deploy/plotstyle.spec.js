const { test, expect } = require('@playwright/test');

// The plot-style panel (#251) against a real deploy. The unit harness drives the
// adapter in jsdom; this is the first thing to run the vendored bundle in a real
// browser, against real matplotlib output from real Pyodide.
async function run(page, code) {
  await page.goto('/embed/python3');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}
const pill = (page) => page.locator('plotpolish-panel');

test.describe('#251 plot style panel', () => {
  test('mounts over a matplotlib figure', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');

    await run(page, 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[2,1,3])\nplt.show()\n');
    await pill(page).waitFor({ state: 'attached', timeout: 90000 });
    console.log('  [#251] panel mounted over a matplotlib figure');
    expect(await pill(page).count()).toBe(1);
  });

  // The VPython-scene guard is NOT reachable on a main-thread glowscript embed:
  // /embed/glowscript has no #graphic element at all (verified on the trial —
  // getElementById('graphic') is null) and renders its scene inside a separate
  // sandboxed frame, so hasFigure() returns false before any container check.
  //
  // The guard's real trigger is the WORKER path, where #vpython-scene is built
  // inside #graphic on a pyodide embed — which needs features.workerVPython, off
  // by default. Both container ids are covered by the jsdom harness in
  // test/unit/plotpolish-adapter.test.js; this is the deployed counterpart, and
  // it skips loudly rather than passing vacuously where it cannot fire.
  test('does NOT mount over a worker VPython scene', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');
    test.skip(!/workerVPython\s*:\s*true/.test(html),
      'features.workerVPython is off — the #vpython-scene container is never built, '
      + 'so this guard cannot be exercised here (unit harness covers both ids)');

    await run(page, 'from vpython import sphere, color\nsphere(color=color.red)\n');
    await page.locator('#vpython-scene').waitFor({ state: 'attached', timeout: 90000 });
    await page.waitForTimeout(2500);
    console.log('  [#251] panels over a worker VPython scene: ' + await pill(page).count());
    expect(await pill(page).count(), 'no style pill over a 3D scene').toBe(0);
  });

  test('leaves a print-only program alone', async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');

    await run(page, 'print("no figure here")\n');
    await page.waitForTimeout(4000);
    expect(await pill(page).count(), 'no figure means no pill').toBe(0);
  });
});

// Save PNG on the WORKER runtime, end to end. On the worker the panel has no
// backend, so its Save asks the host, and the host sends the mpl toolbar's own
// {type:'save'} to the worker and downloads the savefig bytes that come back.
// The unit suite lifts each link of that chain out of the source and runs it;
// only a real browser can run the links together: the worker's Python save
// branch, the request_id it echoes, and the Blob download.
//
// The button is clicked from inside the panel's shadow root rather than by
// navigating to the Save tab. What this spec checks is the route after the
// click, not the tab strip.
async function saveFromPanel(page) {
  await page.evaluate(() => {
    const b = document.querySelector('plotpolish-panel').shadowRoot.querySelector('button.save-fig');
    if (!b) throw new Error('no Save PNG button in the panel');
    b.click();
  });
}
// The panel's status line for that button sits just BEFORE it (the row is
// right-aligned, so the free space is on the left).
const saidText = (page) => page.evaluate(() => {
  const b = document.querySelector('plotpolish-panel').shadowRoot.querySelector('button.save-fig');
  const s = b && b.previousElementSibling;
  return (s && s.classList.contains('copy-said')) ? s.textContent : '';
});

// Pixels-per-metre from the PNG's pHYs chunk; matplotlib writes it from the
// dpi it saved at. Returns null if the chunk is absent.
function pngDpi(buf) {
  expect(buf.subarray(0, 8).toString('hex'), 'a PNG signature').toBe('89504e470d0a1a0a');
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    if (type === 'pHYs') return Math.round(buf.readUInt32BE(at + 8) * 0.0254);
    at += 12 + len;
  }
  return null;
}
async function downloaded(download) {
  const fs = require('fs');
  return fs.readFileSync(await download.path());
}

test.describe('plot style panel: Save PNG on the worker runtime', () => {
  test.beforeEach(async ({ page }) => {
    const html = await (await page.goto('/embed/python3')).text();
    test.skip(!/plotStyle\s*:\s*true/.test(html), 'features.plotStyle is off on this deploy');
    test.skip(!/workerRuntime\s*:\s*true/.test(html), 'main-thread deploy: the panel saves through its own backend there');
  });

  test('Save downloads a PNG at the saved dpi, and a second Save downloads again', async ({ page }) => {
    await run(page, 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[2,1,3])\nplt.show()\n');
    await pill(page).waitFor({ state: 'attached', timeout: 90000 });

    const t0 = Date.now();
    const [first] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), saveFromPanel(page)]);
    const firstMs = Date.now() - t0;
    expect(first.suggestedFilename()).toBe('plot.png');
    const buf = await downloaded(first);
    const dpi = pngDpi(buf);
    console.log('  [save] ' + buf.length + ' bytes, pHYs dpi ' + dpi + ', said "' + await saidText(page) + '"');
    expect(await saidText(page)).toBe('Saved');
    // 300 is the worker's host default savefig.dpi (MPL_SETUP), resolved at
    // save time by _trinket_savefig_dpi -- not the pane fit's figure.dpi.
    expect(dpi, 'saved at savefig.dpi, not the on-screen dpi').toBe(300);

    // The second download is what proves the worker ECHOED the request id. If
    // it had not, the first reply would not settle the panel's wait, and this
    // click would piggyback on a save that already finished: "Saved", and no
    // file until the 10 s watchdog released the button.
    //
    // That proof holds only while the watchdog has NOT fired: once it has, the
    // button is released anyway and the second click sends a fresh request
    // whether or not the echo works. So pin both halves of "not yet".
    // Read from the SERVED pyodide.js, not restated here.
    const served = await (await page.request.get('/js/embed/pyodide.js')).text();
    const timeoutMs = Number(/MPL_SAVE_TIMEOUT_MS\s*=\s*(\d+)/.exec(served)[1]);
    expect(firstMs, 'first save must beat the watchdog, or the next check proves nothing')
      .toBeLessThan(timeoutMs - 2000);
    const consoleText = await page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
    expect(consoleText, 'the watchdog must not have spoken').not.toContain('has not saved');
    const [second] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), saveFromPanel(page)]);
    expect((await downloaded(second)).subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  test('after a Stop, Save says it cannot, and downloads nothing', async ({ page }) => {
    await run(page, 'import matplotlib.pyplot as plt, time\nplt.plot([1,2,3],[2,1,3])\nplt.show()\n'
      + 'while True:\n    time.sleep(0.2)\n');
    await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 90000 });
    const stop = page.locator('.stop-it');
    await expect(stop).toBeVisible({ timeout: 90000 });
    await page.waitForTimeout(500);                  // let the button settle; see stop.spec.js
    await stop.click();
    await pill(page).waitFor({ state: 'attached', timeout: 30000 });

    let got = null;
    page.on('download', (d) => { got = d; });
    await saveFromPanel(page);
    await page.waitForTimeout(2000);
    console.log('  [save after Stop] said "' + await saidText(page) + '"');
    expect(await saidText(page)).toBe("Saving isn't available here");
    expect(got, 'no file after a Stop').toBeNull();
  });
});
