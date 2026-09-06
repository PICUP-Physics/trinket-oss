const { test, expect } = require('@playwright/test');

// Typeset SymPy output (features.mathOutput).
//
// A bare top-level SymPy expression should show the student's own source line,
// numbered as in the code window, with the expression typeset beneath it —
// interleaved with print() output in program order. See
// docs/superpowers/specs/2026-09-03-sympy-math-output-design.md.
//
// These run on ?runtime=main. The worker half of the feature waits on #215
// (module-worker conversion), and this file is parametrised over both runtimes
// when that lands.
//
// The generous timeouts are not padding: Pyodide boots from jsDelivr (~10 MB)
// and `import sympy` auto-loads a package that takes ~3.3 s on 0.28.1, so the
// first assertion of any of these specs is waiting on a real download.

// The oscillator program from the plan. Line numbers matter to the assertions,
// so it is written out with its numbering explicit:
//
//   1  import sympy as sp
//   2  t, w = sp.symbols('t omega', positive=True)
//   3  x = sp.Function('x')
//   4  print("Simple harmonic oscillator")
//   5  eq = sp.Eq(x(t).diff(t, 2), -w**2 * x(t))
//   6  eq                                    <- first card
//   7  sol = sp.dsolve(eq, x(t)); sol        <- second card, same line as the assignment
//   8  print("Period:", 2*sp.pi/w)
//
// The second card is 7, not 8: the bare `sol` shares line 7 with the
// assignment that precedes it on the same line. The assertions below follow the
// program above, which is the authority.
const OSCILLATOR = [
  'import sympy as sp',
  "t, w = sp.symbols('t omega', positive=True)",
  "x = sp.Function('x')",
  'print("Simple harmonic oscillator")',
  'eq = sp.Eq(x(t).diff(t, 2), -w**2 * x(t))',
  'eq',
  'sol = sp.dsolve(eq, x(t)); sol',
  'print("Period:", 2*sp.pi/w)'
].join('\n');

async function setCode(page, source) {
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, source);
}

// Walk the console in DOM order and reduce it to a sequence of tokens, so
// ordering can be asserted directly rather than inferred from string offsets.
// Text nodes collapse to 'text:<trimmed>'; a card becomes 'card:<line number>'.
async function consoleSequence(page) {
  return page.evaluate(() => {
    const root = document.getElementById('console-output');
    if (!root) return [];
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && child.classList.contains('math-card')) {
          const ln = child.querySelector('.math-ln');
          out.push('card:' + (ln ? ln.textContent.trim() : '?'));
          continue;                       // do not descend into the card
        }
        if (child.nodeType === 3) {
          const t = child.textContent.trim();
          if (t) out.push('text:' + t);
          continue;
        }
        if (child.nodeType === 1) walk(child);
      }
    };
    walk(root);
    return out;
  });
}

test('bare SymPy expressions render as typeset cards, in program order', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  await setCode(page, OSCILLATOR);
  await page.locator('.run-it').first().click();

  // One assertion waits for the whole run (Pyodide + SymPy); the rest are then
  // immediate.
  await expect(async () => {
    expect(await page.locator('#console-output .math-card').count()).toBe(2);
  }).toPass({ timeout: 90_000 });

  // The student's line numbers, as they appear in the code window.
  await expect(page.locator('#console-output .math-card .math-ln').nth(0)).toHaveText('6');
  await expect(page.locator('#console-output .math-card .math-ln').nth(1)).toHaveText('7');

  // The echo is the source line the student wrote — including both statements
  // when a line carries two.
  await expect(page.locator('#console-output .math-card .math-src').nth(0)).toHaveText('eq');
  await expect(page.locator('#console-output .math-card .math-src').nth(1))
    .toHaveText('sol = sp.dsolve(eq, x(t)); sol');

  // Typeset, not the degraded text fallback: KaTeX actually rendered.
  await expect(async () => {
    expect(await page.locator('#console-output .math-card .math-body .katex').count()).toBe(2);
  }).toPass({ timeout: 30_000 });

  // KaTeX's MathML is the accessibility story, so assert it is really there.
  expect(await page.locator('#console-output .math-card .math-body math').count()).toBeGreaterThan(0);

  // Interleaving: both prints keep their positions around the two cards.
  const seq = await consoleSequence(page);
  const firstPrint = seq.findIndex((s) => s.includes('Simple harmonic oscillator'));
  const card6 = seq.indexOf('card:6');
  const card7 = seq.indexOf('card:7');
  const lastPrint = seq.findIndex((s) => s.includes('Period:'));
  expect(firstPrint).toBeGreaterThanOrEqual(0);
  expect(lastPrint).toBeGreaterThanOrEqual(0);
  expect(firstPrint).toBeLessThan(card6);
  expect(card6).toBeLessThan(card7);
  expect(card7).toBeLessThan(lastPrint);
});

test('values that cannot typeset themselves stay silent', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  // Every one of these is a bare top-level expression. A script shows none of
  // them today and must show none of them with the flag on: that is what makes
  // this feature a no-op for existing trinkets.
  await setCode(page, [
    '42',
    '"a bare string"',
    '[1, 2, 3]',
    '{"a": 1}',
    'None',
    '3.14',
    'print("done")'
  ].join('\n'));
  await page.locator('.run-it').first().click();

  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('done');
  }).toPass({ timeout: 90_000 });

  expect(await page.locator('#console-output .math-card').count()).toBe(0);
  // No repr of any of those values leaked into the console either.
  const text = await page.locator('#console-output').innerText();
  expect(text).not.toContain('42');
  expect(text).not.toContain('a bare string');
  expect(text).not.toContain('3.14');
});

test('display() is the escape hatch inside a loop', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  // A bare expression inside a loop shows nothing (as in Jupyter); display()
  // is how a student shows one. All three cards come from the same source
  // line, so they carry the same line number.
  await setCode(page, [
    'import sympy as sp',
    "x = sp.symbols('x')",
    'for n in range(1, 4):',
    '    x**n',
    '    display(x**n)'
  ].join('\n'));
  await page.locator('.run-it').first().click();

  await expect(async () => {
    expect(await page.locator('#console-output .math-card').count()).toBe(3);
  }).toPass({ timeout: 90_000 });

  const lines = await page.locator('#console-output .math-card .math-ln').allTextContents();
  expect(lines).toEqual(['5', '5', '5']);
});

test('typeset output survives Clear memory', async ({ page }) => {
  await page.goto('/embed/python3?runtime=main');
  await expect(page.locator('.ace_editor')).toBeVisible();

  await setCode(page, OSCILLATOR);
  await page.locator('.run-it').first().click();
  await expect(async () => {
    expect(await page.locator('#console-output .math-card').count()).toBe(2);
  }).toPass({ timeout: 90_000 });

  // The display module and the builtins it installs are put in place BEFORE the
  // bootstrap namespace snapshot, so the restore Clear memory performs must
  // leave the feature working rather than half-removed.
  await page.locator('.clear-memory-it').click();
  await expect(async () => {
    const text = await page.locator('#console-output').innerText();
    expect(text).toContain('[Python memory cleared.]');
  }).toPass({ timeout: 30_000 });

  await page.locator('.run-it').first().click();
  await expect(async () => {
    // Two, not four. Clear memory preserves the transcript — but Run itself
    // calls resetOutput(), so the second run starts from an empty console and
    // the cards do not accumulate. What this pins is that the second run
    // produces cards AT ALL: the display module and its builtins are installed
    // before the bootstrap namespace snapshot, so the restore Clear memory
    // performs has to leave them in place.
    expect(await page.locator('#console-output .math-card').count()).toBe(2);
  }).toPass({ timeout: 90_000 });
  // And typeset, not the degraded text fallback.
  await expect(page.locator('#console-output .math-card .math-body .katex')).toHaveCount(2);
});
