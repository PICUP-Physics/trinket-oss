const { test, expect } = require('@playwright/test');

// Web VPython computes the right numbers on this deploy.
//
// The runtime (glow/RScompiler/RSrun) is fetched from a pinned rsWVPRunner
// release at image build time. deploy-smoke only proves a program draws a
// canvas, so a compiler that miscomputes passes it. These programs pin two bugs
// fixed in rsWVPRunner v3.2.4 (vpython/glowscript#215 and #223); on the older
// runtime every expectation below fails:
//
//   3/-3 gave -9, 7 // -2 gave -14, vec(1,2,3)/-2 gave <-2,-4,-6>
//     (unary minus was rewritten as "-1*" before compiling)
//   randint(-2, 2) never returned -2; randint(-5, -1) returned 0
//     (randint truncated toward zero)
//
// Anonymous and unsaved, like deploy-smoke, so it is safe on a live server.

async function runAndRead(page, body) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, 'Web VPython 3.2\n' + body + '\n');
  await page.locator('.run-it:visible').first().click();

  // The program runs in a sandboxed srcdoc iframe; print() lands in its textarea.
  let out = '';
  await expect(async () => {
    for (const frame of page.frames()) {
      if (frame.url() !== 'about:srcdoc') continue;
      const text = await frame.evaluate(() =>
        [...document.querySelectorAll('textarea')].map((t) => t.value).join('\n')
      ).catch(() => '');
      const line = text.split('\n').find((l) => l.startsWith('R '));
      if (line) { out = line; break; }
    }
    expect(out, 'program printed no result line').not.toBe('');
  }).toPass({ timeout: 90_000 });
  return out.slice(2).trim().split(/\s+/);
}

test.describe('Web VPython arithmetic', () => {
  test('division by a negative number', async ({ page }) => {
    const r = await runAndRead(page, 'print("R", 3/-3, 7 // -2, 2/-(5), -10**2)');
    expect(r).toEqual(['-1', '-4', '-0.4', '-100']);
  });

  test('a vector divided by a negative number', async ({ page }) => {
    const r = await runAndRead(page, 'v = vec(1,2,3)/-2\nprint("R", v.x, v.y, v.z)');
    expect(r).toEqual(['-0.5', '-1', '-1.5']);
  });

  test('randint covers a range that crosses zero', async ({ page }) => {
    // 5000 draws over 5 values: each appears ~1000 times, so missing one is not chance.
    const r = await runAndRead(page, [
      'from random import randint',
      'seen = {}',
      'for i in range(5000):',
      '    seen[randint(-2, 2)] = 1',
      'k = sorted(seen.keys())',
      'print("R", len(k), k[0], k[-1])',
    ].join('\n'));
    expect(r).toEqual(['5', '-2', '2']);
  });

  test('randint stays inside an all-negative range', async ({ page }) => {
    const r = await runAndRead(page, [
      'from random import randint',
      'bad = 0',
      'lo = 0',
      'for i in range(3000):',
      '    k = randint(-5, -1)',
      '    lo = min(lo, k)',
      '    if k >= 0:',
      '        bad += 1',
      'print("R", bad, lo)',
    ].join('\n'));
    expect(r).toEqual(['0', '-5']);
  });
});
