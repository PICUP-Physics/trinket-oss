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
// A wider table of expressions, each checked against CPython's answer, guards
// the rest of the arithmetic, including "- -x", which the first #223 runtime
// compiled as the JavaScript decrement "--x". Differences from Python that
// predate these fixes (vpython/glowscript#224) are pinned as known, so a
// runtime that fixes or breaks one shows up here.
//
// Anonymous and unsaved, like deploy-smoke, so it is safe on a live server.

// Runs a program and returns everything it printed, once it prints a line
// starting with "R ".
async function runProgram(page, body) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor').first()).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, 'Web VPython 3.2\n' + body + '\n');
  await page.locator('.run-it:visible').first().click();

  // The program runs in a sandboxed srcdoc iframe; print() lands in its textarea.
  let out = '';
  let compileError = '';
  await expect(async () => {
    // A program that does not compile reports it here and never prints.
    const alert = page.locator('#statusMessages.alert:visible');
    if (await alert.count()) compileError = (await alert.innerText()).trim();
    if (compileError) return;
    for (const frame of page.frames()) {
      if (frame.url() !== 'about:srcdoc') continue;
      const text = await frame.evaluate(() =>
        [...document.querySelectorAll('textarea')].map((t) => t.value).join('\n')
      ).catch(() => '');
      if (text.split('\n').some((l) => l.startsWith('R '))) { out = text; break; }
    }
    expect(out, 'program printed no result line').not.toBe('');
  }).toPass({ timeout: 90_000 });
  expect(compileError, 'program did not compile').toBe('');
  return out;
}

async function runAndRead(page, body) {
  const line = (await runProgram(page, body)).split('\n').find((l) => l.startsWith('R '));
  return line.slice(2).trim().split(/\s+/);
}

const SETUP = ['x = 5', 'y = 2', 'w = -4', 'L = [-1, -2]', 'def f(t):', '    return t'];

// [Python source, CPython's value]. A two-line source is statements that
// leave their result in a.
const PASSING = [
  ["3/-3", -1],
  ["3 / -3", -1],
  ["7 // -2", -4],
  ["10 ** - 2", 0.01],
  ["x/-y", -2.5],
  ["1/-x**2", -0.04],
  ["2/-(x)", -0.4],
  ["-10**2", -100],
  ["-x**2", -25],
  ["-2**0.5", -1.4142135623730951],
  ["-x**-2", -0.04],
  ["10**-2", 0.01],
  ["1e-3", 0.001],
  ["2E-2", 0.02],
  ["2*-3", -6],
  ["-3*-3", 9],
  ["x - y", 3],
  ["x-y", 3],
  ["x -y", 3],
  ["-(x+y)", -7],
  ["f(-1)", -1],
  ["L[1]", -2],
  ["L[-1]", -2],
  ["w", -4],
  ["-w", 4],
  ["sum(range(-3, 0))", -6],
  ["6/-2/-3", 1],
  ["-6/-2", 3],
  ["2**-2", 0.25],
  ["- -3", 3],
  ["- -x", 5],
  ["(- -x)*100 + x", 505],
  ["- - -x", -5],
  ["+ +x", 5],
  ["- +x", -5],
  ["+ -x", -5],
  ["-(-x)", 5],
  ["x - -x", 10],
  ["x + +x", 10],
  ["3 - - 3", 6],
  ["7/2", 3.5],
  ["-7/2", -3.5],
  ["1/3", 0.3333333333333333],
  ["7//2", 3],
  ["-7//2", -4],
  ["7//-2", -4],
  ["-7//-2", 3],
  ["7.5//2", 3],
  ["-7.5//2", -4],
  ["6//3", 2],
  ["0/5", 0],
  ["2.5*4", 10],
  ["7 % 3", 1],
  ["-7 % -3", -1],
  ["7.5 % 2", 1.5],
  ["10 % 5", 0],
  ["2+3*4", 14],
  ["(2+3)*4", 20],
  ["-2**2", -4],
  ["(-2)**2", 4],
  ["2*3**2", 18],
  ["10-4-3", 3],
  ["100/10/5", 2],
  ["2**-1", 0.5],
  ["(-8)**(1/3) if False else 0", 0],
  ["-3**2+1", -8],
  ["1 < 2 < 3 and 1 or 0", 1],
  ["3 > 2 > 1 and 1 or 0", 1],
  ["1 < 3 < 2 and 1 or 0", 0],
  ["-1 < 0 and 1 or 0", 1],
  ["-2 == -2.0 and 1 or 0", 1],
  ["5 != 5 and 1 or 0", 0],
  ["abs(-3)", 3],
  ["abs(-2.5)", 2.5],
  ["int(2.7)", 2],
  ["int(-2.7)", -2],
  ["int(\"-12\")", -12],
  ["float(\"-3.5\")", -3.5],
  ["round(2.567, 2)", 2.57],
  ["round(-2.567, 1)", -2.6],
  ["round(2.4)", 2],
  ["round(-2.6)", -3],
  ["round(3.5)", 4],
  ["min(3, -2, 7)", -2],
  ["max(-3, -2, -7)", -2],
  ["min([4, -1, 2])", -1],
  ["sum([1, -2, 3.5])", 2.5],
  ["pow(2, -1)", 0.5],
  ["pow(-2, 3)", -8],
  ["sqrt(16)", 4],
  ["len(range(-3, 3))", 6],
  ["len(range(5, -5, -2))", 5],
  ["sum(range(10, 0, -3))", 22],
  ["divmod(7, 2)[0]", 3],
  ["divmod(-7, 2)[1]", 1],
  ["sin(0)", 0],
  ["cos(pi)", -1],
  ["atan2(-1, -1)", -2.356194490192345],
  ["exp(-1)", 0.36787944117144233],
  ["floor(-2.5)", -3],
  ["ceil(-2.5)", -2],
  ["radians(-180)", -3.141592653589793],
  ["degrees(-pi/2)", -90],
  ["2**31", 2147483648],
  ["2**31 + 1", 2147483649],
  ["-2**31 - 1", -2147483649],
  ["2**52 + 1", 4503599627370497],
  ["10**15 // 7", 142857142857142],
  ["a = 7\na //= -2", -4],
  ["a = 7\na -= -3", 10],
  ["a = 10\na /= -4", -2.5],
  ["a = 2\na *= -x", -10],
];

// Pre-existing differences from Python (vpython/glowscript#224), with
// Python's value. The runtime gets each of these wrong today.
const KNOWN = {
  mod: [
    ["7 % -3", -2],
    ["-7 % 3", 2],
    ["-7.5 % 2", 0.5],
    ["a = 7\na %= -3", -2],
  ],
  pow: [
    ["2**3**2", 512],
    ["2**-1**2", 0.5],
  ],
  round: [
    ["round(2.5)", 2],
    ["round(-2.5)", -2],
  ],
  bool: [
    ["int(True)", 1],
    ["True + 1", 2],
  ],
  e: [
    ["log(e)", 1],
  ],
};

// One program that prints "C|<row>|<value>" for every row, an error as ERR.
function tableProgram(rows) {
  const out = [...SETUP];
  rows.forEach(([src], i) => {
    const stmts = src.includes('\n') ? src.split('\n') : [];
    const value = stmts.length ? 'a' : src;
    out.push('try:', ...stmts.map((l) => '    ' + l),
      `    print("C|${i}|" + str(${value}))`, 'except:', `    print("C|${i}|ERR")`);
  });
  out.push('print("R done")');
  return out.join('\n');
}

// The sources of the rows whose printed value is not Python's.
function differFromPython(rows, text) {
  const got = new Map();
  for (const line of text.split('\n')) {
    const m = /^C\|(\d+)\|(.*)$/.exec(line);
    if (m) got.set(Number(m[1]), m[2].trim());
  }
  return rows.filter(([, want], i) => {
    const v = got.get(i);
    const n = Number(v);
    return !(v && Number.isFinite(n) && Math.abs(n - want) <= 1e-12 * Math.max(1, Math.abs(want)));
  }).map(([src], i) => src);
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

  test(`${PASSING.length} expressions give Python's answers`, async ({ page }) => {
    const text = await runProgram(page, tableProgram(PASSING));
    expect(differFromPython(PASSING, text)).toEqual([]);
  });

  test('the known differences from Python are exactly the known ones', async ({ page }) => {
    // When the runtime fixes one, move its row to PASSING; a new entry here
    // is a regression.
    const rows = Object.values(KNOWN).flat();
    const text = await runProgram(page, tableProgram(rows));
    expect(differFromPython(rows, text)).toEqual(rows.map(([src]) => src));
  });

  test('a **= 2 compiles (known difference, vpython/glowscript#224)', async ({ page }) => {
    test.fail();
    const r = await runAndRead(page, 'a = 3\na **= 2\nprint("R", a)');
    expect(r).toEqual(['9']);
  });
});
