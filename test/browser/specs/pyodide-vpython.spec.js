const { test, expect } = require('@playwright/test');

// The MAIN-THREAD Pyodide VPython path — `/embed/python3` running a VPython
// program through the bespoke `from js import sphere, …` bridge, drawn by the
// glow build `GLOW_SRC` points at.
//
// Why this file exists: that pin moved 3.2.2 → 3.2.3 (spec 2026-08-10, decision
// V3), and it is the ONE change on the vpython-jupyter branch that reaches a
// deploy with every flag off. It was verified once, by a spec that was then
// deleted. Nothing else in the suite covers this loader: `webvpython.spec.js`
// exercises `/embed/glowscript`, which is a different one, and the worker specs
// skip entirely unless `features.workerVPython` is on. So without this file a
// future rsWVPRunner rebuild could break VPython for every student and CI would
// stay green.
//
// It runs with `?runtime=main`, which is not decoration: on a stack with
// `workerVPython` on — which the dev stack has — the router would otherwise send
// this program to the worker and the pin would go untested. `?runtime=main` is
// the documented escape hatch and it beats the flag.

// Deliberately small, and deliberately not static: `rate()` is the call the
// bridge makes synchronous on this path (the whole reason VPython does not go
// off-thread by default), so a loop that runs and then ENDS proves the program
// was paced and released rather than just constructed. The red sphere is what
// the pixel read looks for.
const PROGRAM = [
  'from vpython import *',
  'ball = sphere(color=color.red, radius=1.5)',
  'for i in range(20):',
  '    rate(30)',
  '    ball.pos = vec(i / 40.0, 0, 0)',
  'print("done", ball.pos.x)',
  ''
].join('\n');

test.describe('Main-thread Pyodide VPython (default path)', () => {
  test('a VPython program renders on the pinned glow build', async ({ page }) => {
    test.setTimeout(300_000);           // cold Pyodide boot + the vpython bridge zip

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate((code) => {
      document.querySelector('.ace_editor').env.editor.setValue(code, 1);
    }, PROGRAM);
    await page.locator('.run-it').first().click();

    // The program ran HERE, not in a worker. If this ever flips, everything
    // below is testing the other path and the pin is unguarded again.
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
      // glow is lazy: a canvas with no objects produces no <canvas> element at
      // all, so the element is the "the scene is really up" signal.
      expect(await page.evaluate(() =>
        document.querySelectorAll('#glowscript canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 240_000 });

    // The program finished — the synchronous rate() loop paced and released.
    await expect(async () => {
      const out = await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '');
      expect(out).toContain('done');
    }).toPass({ timeout: 120_000 });

    // It is the pinned build that drew it. This is the assertion the whole file
    // is for: `GLOW_SRC`, read off the page rather than off the source.
    const glowSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script'))
        .map((s) => s.src).filter((s) => /glow\.[\d.]+\.min\.js/.test(s)));
    expect(glowSrcs.length, 'no glow library was loaded at all').toBeGreaterThan(0);
    expect(glowSrcs.join(' ')).toContain('glow.3.2.3.min.js');

    // ...and it rasterised. A canvas element with a WebGL context is not proof a
    // frame was drawn; red pixels are. glow does not ask for
    // preserveDrawingBuffer, so the read has to happen INSIDE a frame, and it
    // retries across frames rather than sampling one at an arbitrary deadline
    // (the canary spec learned that the hard way on a loaded machine).
    const pixels = await page.evaluate(async () => {
      const cv = document.querySelector('#glowscript canvas');
      const name = ['webgl2', 'webgl', 'experimental-webgl']
        .find((n) => { try { return !!cv.getContext(n); } catch (e) { return false; } });
      if (!name) return { red: -1, why: 'no WebGL context' };
      const gl = cv.getContext(name);
      const readRed = () => {
        const px = new Uint8Array(4 * cv.width * cv.height);
        gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 60 && px[i + 1] < 60 && px[i + 2] < 60) n++;
        }
        return n;
      };
      let red = -1;
      const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 120 && red <= 100; i++) {   // ~2 s at 60 fps
        await nextFrame();
        red = readRed();
      }
      return { red, w: cv.width, h: cv.height };
    });
    expect(pixels.red, 'the red sphere never rasterised: ' + JSON.stringify(pixels))
      .toBeGreaterThan(100);

    expect(pageErrors, 'uncaught page exception on the main-thread VPython path').toEqual([]);
  });

  // #316: the classic "Web VPython 3.2" first line does not parse as Python,
  // so an import scan of the raw file found nothing and none of the main
  // file's packages loaded -- numpy here, on origin/main at 8c72067. runVpython
  // comments the header out before running; the scan now sees the same text.
  test('a Web VPython header does not stop the main file\'s imports loading', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate((code) => {
      document.querySelector('.ace_editor').env.editor.setValue(code, 1);
    }, [
      'Web VPython 3.2',
      'from vpython import *',
      'import numpy as np',
      'sphere(color=color.red)',
      'print("header ok", int(np.arange(3).sum()))',
      ''
    ].join('\n'));
    await page.locator('.run-it').first().click();

    await expect(async () => {
      const out = await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '');
      expect(out).not.toContain('No module named');
      expect(out).toContain('header ok 3');
    }).toPass({ timeout: 240_000 });
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });
});
