const { test, expect } = require('@playwright/test');

// THE FIGSIZE RATCHET, READ OFF THE DOWNLOADED FILE.
//
// The whole claim of the pane fit is that the window sets SCALE and the student
// sets SHAPE: fitting scales `figure.dpi` with `figsize` held fixed, so the file
// you download is the same composition however wide the browser happened to be.
// A ratchet -- a fit that quietly recomputes figsize -- breaks exactly that, and
// it is invisible on screen, because a figure that got 1% narrower in inches and
// 1% denser in dpi occupies the same pixels.
//
// panefit.spec.js checks the fit's own state and the canvas geometry. Neither
// can see figsize on the WORKER: Python is in a worker thread and the page has
// no channel to ask it, so `window.__trinketPaneFit` reports the box and the
// classifier's decisions but nothing from matplotlib. That is the gap this file
// exists for, and it is the runtime where the ratchet is most likely, because
// the worker's fit round trip is asynchronous and can overlap other traffic.
//
// The trick, from Fable's consult-7 probe `t7_3_worker_ratchet.js` (kept at
// harness/pw/consult7-probes/ and NOT runnable as rescued -- its shared `h.js`
// never made it out of that session's scratchpad, so this is a port onto the
// repo's own helpers rather than a copy): drive the toolbar's own Download,
// intercept the blob before it reaches the filesystem, and read the PNG's IHDR.
// `savefig.dpi` is pinned to 300, so width_px / 300 IS figsize[0] in inches,
// straight from Agg. Python never has to be asked.
//
// TWO independent pins that happen to agree, and the WORKER's is the one this
// file is named for: pyodide.js:83 for the main thread, pyodide-worker.js:379
// for the worker, which carries its own setup string, its own
// _trinket_savefig_dpi() and its own save path. Mutating only the main-thread
// pin moves main and leaves the worker at 1440x1080, which looks exactly like
// "the worker ignores savefig.dpi" and is not.
//
// 660_000: see the note in panefit.spec.js. runFigure waits up to 240_000 and
// the slower test then walks five download cycles behind it (a baseline plus
// four fits), so the enclosing budget has to exceed the largest assertion
// timeout AND cover the walk.
test.describe.configure({ timeout: 660_000 });

const SAVEFIG_DPI = 300;

const PROG = [
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  't = np.linspace(0, 10, 300)',
  'plt.plot(t, np.exp(-0.35*t)*np.cos(4*t))',
  "plt.xlabel('time (s)'); plt.ylabel('displacement (m)'); plt.title('Damped')",
  'plt.show()',
  'print("FINI")',
].join('\n');

// Capture the download in the page instead of letting Playwright save it: mpl.js
// builds a blob URL and clicks a synthetic anchor, and the bytes are what we
// want, not a file on disk. Installed as an init script so it is in place before
// any figure exists.
const CAPTURE_DOWNLOADS = () => {
  window.__downloads = [];
  window.__blobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    const u = orig(b);
    window.__blobs.push({ url: u, blob: b });
    return u;
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      const href = this.getAttribute('href') || '';
      const rec = window.__blobs.find(b => b.url === href);
      window.__downloads.push({
        name: this.download,
        href: href.startsWith('data:') ? href : null,
        blob: rec ? rec.blob : null,
      });
      return;                       // swallow it; nothing should hit the disk
    }
    return click.call(this);
  };
};

async function runFigure(page, query, viewport) {
  await page.addInitScript(CAPTURE_DOWNLOADS);
  await page.setViewportSize(viewport);
  await page.goto('/embed/python3' + query);
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((s) => {
    document.querySelector('.ace_editor').env.editor.setValue(s, 1);
  }, PROG);
  // The embed's own event, not `.run-it`: below about 1100 px that control is a
  // split button whose click opens a menu instead of running.
  await page.evaluate(() => { $('#editor').trigger('trinket.code.run', { action: 'code.run' }); });
  // textContent, not innerText: at narrow widths the output pane is tabbed and
  // innerText of the hidden console is '', which reads as a run that never
  // finished and times out four minutes later.
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('#console-output')?.textContent || ''),
    { timeout: 240_000 }).toContain('FINI');
  await page.locator('#graphic canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(4000);           // the fit's round trip, then settle
}

// Press Download and decode the PNG header. Returns null if nothing was
// captured, which the vacuity guard below turns into a failure rather than a
// silently skipped assertion.
async function downloadFigsize(page) {
  await page.evaluate(() => { window.__downloads.length = 0; });
  await page.locator('#graphic button.mpl-widget[title^="Download"]').first().click();
  // Agg has to render the whole figure at 300 dpi and ship it back; on the
  // worker that is a round trip through the worker's own message queue.
  await expect.poll(async () => page.evaluate(() => window.__downloads.length),
    { timeout: 60_000, message: 'the toolbar Download produced no blob' }).toBeGreaterThan(0);
  return page.evaluate(async (dpi) => {
    const d = window.__downloads[0];
    let bytes;
    if (d.blob) {
      bytes = new Uint8Array(await d.blob.arrayBuffer());
    } else if (d.href) {
      const bin = atob(d.href.split(',')[1]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      return { png: false, reason: 'neither a blob nor a data: href' };
    }
    // PNG signature, then IHDR width/height as big-endian u32 at bytes 16..23.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || sig.some((v, i) => bytes[i] !== v)) {
      return { png: false, reason: 'not a PNG', bytes: bytes.length, name: d.name };
    }
    const u32 = (o) => ((bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0);
    const px = [u32(16), u32(20)];
    return { png: true, name: d.name, bytes: bytes.length, px, figsize: [px[0] / dpi, px[1] / dpi] };
  }, SAVEFIG_DPI);
}

function readProbe(page) {
  return page.evaluate(() => {
    const st = window.__trinketPaneFit.state();
    const one = st[Object.keys(st)[0]];
    const c = document.querySelector('#graphic canvas');
    return {
      box: one.box,
      pendingFits: one.pendingFits,
      canvas: { w: c.clientWidth, h: c.clientHeight },
      kinds: window.__trinketPaneFit.classified.map(e => e.kind),
      log: window.__trinketPaneFit.classified.map(e => `${e.kind}:${e.w}x${e.h}`),
    };
  });
}

// A drag of the figure's own corner handle: hold ~150 ms, then steps ~40 ms
// apart, matching panefit.spec.js.
//
// The hold is usually justified by "a fast synthetic drag never engages
// `resize: both`". Measured here rather than repeated, three gestures on the
// same page on main:
//
//   A  this drag (80 + 150 + 6x40 ms)      559 ms   +6 drag entries  395 -> 275
//   B  the same with every wait removed     59 ms   +1 drag entry    515 -> 395
//   C  the whole gesture inside one evaluate, synthetic MouseEvents
//                                          5.9 ms    0 drag entries  div UNMOVED
//
// So the fact holds at the limit (C) and not at B: four CDP round trips still
// leave ~15 ms between mousedown and mousemove, and 15 ms is enough to engage
// the native resizer. Removing the explicit waits is a mutation of the waits,
// not of the timing.
//
// The hold stays, for a reason the old comment did not give: B lands ONE drag
// sample and A lands SIX. The guard below is `> 0`, so both pass, but a
// one-sample drag exercises neither the classifier's repeat handling nor the
// 150 ms fit debounce -- and on a faster machine CDP latency shrinks toward C.
async function slowCornerDrag(page, dx, dy) {
  const c = await page.evaluate(() => {
    const r = document.querySelector('#graphic canvas').parentNode.getBoundingClientRect();
    return { x: Math.round(r.right - 5), y: Math.round(r.bottom - 5) };
  });
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.waitForTimeout(150);
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(c.x + dx * i / 6, c.y + dy * i / 6);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(2500);
}

// Both runtimes. The worker is the one this technique exists for, but main is
// the control: the same walk with a synchronous round trip. A ratchet that shows
// on both is a bug in the fit; one that shows only on the worker is a bug in the
// asynchronous path, and the file should say which.
for (const [label, query] of [['worker', '?runtime=worker'], ['main', '?runtime=main']]) {
  test.describe(`figsize ratchet (${label})`, () => {
    test(`${label}: resizing the pane never changes the downloaded figure`, async ({ page }) => {
      await runFigure(page, query, { width: 1280, height: 900 });

      const first = await downloadFigsize(page);

      // VACUITY GUARD, BEFORE ANYTHING ELSE. Every assertion below compares
      // figsizes recovered from a PNG. If the interception missed the blob, if
      // the toolbar shipped an SVG because the format dropdown moved, or if the
      // IHDR decode landed on the wrong offset, the comparisons are between two
      // pieces of the same garbage and pass. Mutation-tested by pointing the
      // decoder at byte 0 instead of 16: the bounds below caught it, reporting
      // figsize 7679138.37 in -- the PNG signature read as a u32 -- before the
      // walk ran. The bounds are the guard; `png === true` alone is not, because
      // a valid signature says nothing about where the dimensions were read.
      expect(first, 'the Download was intercepted').not.toBeNull();
      expect(first.png, `the download is a PNG: ${JSON.stringify(first)}`).toBe(true);
      expect(first.px[0], `IHDR width looks like a figure: ${JSON.stringify(first)}`)
        .toBeGreaterThan(300);
      // PIN THE DIVISOR. If the effective savefig.dpi is not 300, every figsize
      // here is wrong by that ratio and the walk still passes, because it only
      // ever compares figsizes to each other -- invariance and change are both
      // ratios. What a wrong divisor corrupts is every number printed in a
      // failure message, which is what a person debugging acts on.
      //
      // The figure is 4.8 x 3.6 in: BOTH setup strings set figure.figsize
      // (pyodide.js:78, pyodide-worker.js:374), so at 300 dpi this is
      // 1440 x 1080 px on both runtimes, measured. An earlier version of this
      // comment said "matplotlib's default figure, which the program does not
      // resize: 6.4 x 4.8 in ... 1920 x 1440" -- wrong on both counts, and that
      // error is how the bounds came to be 3..20, a window admitting 187 to
      // 1250 dpi. Verified: at those bounds, mutating either setup string to
      // savefig.dpi = 600 gave 2880 x 2160 and the guard said nothing.
      //
      // +/-10% of the true figure, which is a guard rather than a sanity check.
      expect(first.figsize[0], `figsize from a ${SAVEFIG_DPI} dpi PNG: ${JSON.stringify(first)}`)
        .toBeGreaterThan(4.3);
      expect(first.figsize[0], `figsize from a ${SAVEFIG_DPI} dpi PNG: ${JSON.stringify(first)}`)
        .toBeLessThan(5.3);

      // THE WALK. Fits only -- four different pane widths, no drags. Every one
      // of these must leave the downloaded file byte-identical in composition.
      const FITS = [1000, 1400, 900, 1280];
      const seen = [{ at: 'start (1280)', figsize: first.figsize, px: first.px }];
      for (const w of FITS) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(3500);            // debounce, round trip, settle
        const d = await downloadFigsize(page);
        expect(d.png, `download at ${w}px is a PNG: ${JSON.stringify(d)}`).toBe(true);
        seen.push({ at: `fit ${w}`, figsize: d.figsize, px: d.px });
      }

      // Vacuity guard for the walk itself: if the fits never bit, nothing was
      // tested. The canvas must actually have changed size across the sequence.
      const probe = await readProbe(page);
      expect(probe.kinds.filter(k => k === 'echo').length,
        `the fits never reached Python: ${probe.log.join(' ')}`).toBeGreaterThan(1);

      // SYMPTOM FIRST: what a student would see, which is that the file they
      // download is the same picture whatever the window did. Compared in whole
      // PIXELS, not rounded inches -- a ratchet of a hundredth of an inch is 3 px
      // at 300 dpi and is exactly the drift this guards against.
      for (const s of seen.slice(1)) {
        expect(s.px, `${s.at} changed the downloaded file. Walk: ${JSON.stringify(seen)}`)
          .toEqual(seen[0].px);
      }

      // MECHANISM SECOND: a fit is classified as an echo, never as a drag.
      // Nobody dragged anything yet, and a misclassified echo IS the ratchet.
      expect(probe.kinds.filter(k => k === 'drag'),
        `no drags yet: ${probe.log.join(' ')}`).toHaveLength(0);
      expect(probe.pendingFits, 'fits in flight are bounded').toBeLessThanOrEqual(2);
    });

    test(`${label}: a corner drag does change it, and the new shape then holds`, async ({ page }) => {
      // The other half, and the reason the test above is not vacuous: figsize is
      // not simply frozen. The student's corner drag is the one thing that IS
      // allowed to recompute it, so if the first test passed because nothing can
      // ever change figsize, this one fails.
      await runFigure(page, query, { width: 1280, height: 900 });
      const before = await downloadFigsize(page);
      expect(before.png, `baseline is a PNG: ${JSON.stringify(before)}`).toBe(true);

      await slowCornerDrag(page, -140, -90);

      const probe = await readProbe(page);
      // Vacuity guard: the native resizer is easy to miss entirely, and a walk
      // over a drag that never happened proves nothing.
      expect(probe.kinds.filter(k => k === 'drag').length,
        `the corner drag never engaged the native resizer: ${probe.log.join(' ')}`)
        .toBeGreaterThan(0);

      const after = await downloadFigsize(page);
      expect(after.png, `post-drag download is a PNG: ${JSON.stringify(after)}`).toBe(true);
      expect(after.px, `the drag did not reach the downloaded file: ${before.px} -> ${after.px}`)
        .not.toEqual(before.px);

      // And then the NEW shape is what fits preserve. This is the ratchet's real
      // hiding place: a fit after a drag, where the classifier has just seen a
      // genuine drag and the next echo arrives on its heels.
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.waitForTimeout(3500);

      // VACUITY GUARD for this clause, and it was missing: with paneFit disabled
      // outright the assertion below passes, because "the fit preserved the
      // shape" and "no fit happened" are the same pixels. Test 1's guard caught
      // that mutation and this one did not.
      const afterProbe = await readProbe(page);
      expect(afterProbe.kinds.filter(k => k === 'echo').length,
        `the post-drag fit never reached Python: ${afterProbe.log.join(' ')}`)
        .toBeGreaterThan(probe.kinds.filter(k => k === 'echo').length);

      const refit = await downloadFigsize(page);
      expect(refit.px, `a fit after a drag moved figsize: ${after.px} -> ${refit.px}`)
        .toEqual(after.px);
    });
  });
}
