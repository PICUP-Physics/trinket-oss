const { test, expect } = require('@playwright/test');

// #316: pre-run setup is decided from what Pyodide LOADED, and every .py file's
// imports are loaded -- not from the main file's text. Each case below failed
// on main at 8c72067:
//
//   pylab      `from pylab import *` loaded matplotlib but skipped the backend
//              setup: figure outside #graphic on main, ImportError on the worker.
//   helper     a package imported only from helper.py was never fetched.
//   transitive networkx pulled matplotlib in; a helper's plot then failed as pylab.
//   typo       a matplotlib program that did not parse loaded nothing, yet the
//              setup's `import matplotlib` ran and replaced the SyntaxError with
//              "No module named 'matplotlib'" at main.py line 1.
//
// Run on BOTH runtimes because the worker has its own copy of the scanner
// (pyodide-worker.js, loadImportsFromSources), and through Step through, which
// has its own load site. A regex-only fix passes `pylab` and fails the rest;
// a scan-only fix passes `helper` and fails `transitive` and `typo`.
//
// Lives in specs/, the suite browser-smoke.yml runs. That workflow runs on a
// manual dispatch or a deploy-* tag, NOT on pull requests, so a PR's checks do
// not exercise this file. It runs the default flags, where the Step through
// cases skip; they run on a stack with stepDebugger + variableExplorer on.
//
// Multi-file programs are passed in the #code fragment, which the embed splits
// on ----{name}---- lines. Every case loads a fresh page: goto with a new
// fragment alone does NOT reload an embed, so each test starts from about:blank.

const PROGRAMS = {
  pylab: "from pylab import *\nplot([1,2,3],[1,4,9])\nshow()\nprint('FINI')\n",
  helper: "import helper\nprint(helper.f(), 'FINI')\n\n----{helper.py}----\n" +
          "from sympy import sqrt\ndef f():\n    return sqrt(2)\n",
  transitive: "import networkx\nimport helper\nhelper.f()\nprint('FINI')\n\n----{helper.py}----\n" +
              "import matplotlib.pyplot as plt\ndef f():\n    plt.plot([1,2,3],[1,4,9]); plt.show()\n",
  typo: "import numpy as np\nimport matplotlib.pyplot as plt\ny_array = np.zeros(3)\ny_array(0) = 1\n",
};

async function open(page, runtime, src) {
  await page.goto('about:blank');
  await page.goto('/embed/python3?runtime=' + runtime + '#code=' + encodeURIComponent(src));
  await expect(page.locator('.ace_editor').first()).toBeVisible();
}

// Run-while-running is ignored for an ordinary program (runCode), and the
// sentinel prints BEFORE the post-run flush and finishRun(). finishRun hides
// Stop, so that is the completion signal to wait on before the next Run.
async function waitForRunEnd(page) {
  await expect(page.locator('.stop-it').first()).toBeHidden({ timeout: 60_000 });
}

async function consoleText(page) {
  return page.evaluate(() => document.querySelector('#console-output')?.innerText || '');
}

// Figure INK, not element counts: a figure container can exist and be blank.
// Same measure as worker-runtime.spec.js -- non-white, non-transparent pixels.
async function paintedInPane(page) {
  return page.evaluate(() => {
    let n = 0;
    document.querySelectorAll('#graphic canvas').forEach((c) => {
      if (!c.width || !c.height) return;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        if (((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) !== 0xffffff) n++;
      }
    });
    return n;
  });
}

async function canvasesOutsidePane(page) {
  return page.evaluate(() => [...document.querySelectorAll('canvas')]
    .filter((c) => !document.getElementById('graphic').contains(c)).length);
}

async function expectFigureInPane(page) {
  // The pane now opens when a figure is shown, not before the run (#316).
  await expect(page.locator('#graphic-wrap')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => paintedInPane(page), { timeout: 60_000 }).toBeGreaterThan(500);
  expect(await canvasesOutsidePane(page), 'no figure drawn over the page (#21)').toBe(0);
}

async function expectRealSyntaxError(text) {
  expect(text).toContain('SyntaxError');
  expect(text).toMatch(/line 4/);
  expect(text, 'the setup must not replace the student\'s error').not.toContain('No module named');
}

for (const runtime of ['main', 'worker']) {
  test.describe(`#316 on the ${runtime} runtime`, () => {
    test.describe.configure({ timeout: 240_000 });

    async function run(page, src) {
      await open(page, runtime, src);
      await page.locator('.run-it').first().click();
    }

    test('`from pylab import *` gets the backend and draws in the pane', async ({ page }) => {
      await run(page, PROGRAMS.pylab);
      await expect.poll(() => consoleText(page), { timeout: 180_000 }).toContain('FINI');
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe(runtime);
      await expectFigureInPane(page);
    });

    test('a package imported only from helper.py is loaded', async ({ page }) => {
      await run(page, PROGRAMS.helper);
      await expect.poll(() => consoleText(page), { timeout: 180_000 }).toContain('sqrt(2) FINI');
    });

    test('matplotlib pulled in by another package still gets the backend', async ({ page }) => {
      await run(page, PROGRAMS.transitive);
      await expect.poll(() => consoleText(page), { timeout: 180_000 }).toContain('FINI');
      await expectFigureInPane(page);
    });

    test('a SyntaxError in a matplotlib program is reported as itself', async ({ page }) => {
      await run(page, PROGRAMS.typo);
      await expect.poll(() => consoleText(page), { timeout: 180_000 }).toContain('SyntaxError');
      await expectRealSyntaxError(await consoleText(page));
    });
  });
}

test.describe('#316 across runs in one main-thread session', () => {
  test.describe.configure({ timeout: 240_000 });

  // loadedPackages persists, so after one plotting run matplotlibLoaded() is
  // true for every later run. Two things must not follow from that: an empty
  // pane on a print-only run, and the console transform being skipped.
  test('a print-only run after a plotting run opens no pane, and console.input is still awaited', async ({ page }) => {
    await open(page, 'main', PROGRAMS.pylab);
    const runSrc = async (src) => {
      await page.evaluate((s) => document.querySelector('.ace_editor').env.editor.setValue(s, 1), src);
      await page.locator('.run-it').first().click();
    };
    await page.locator('.run-it').first().click();
    await expect.poll(() => consoleText(page), { timeout: 180_000 }).toContain('FINI');
    await waitForRunEnd(page);

    await runSrc("print('ONLY PRINTING')\n");
    await expect.poll(() => consoleText(page), { timeout: 60_000 }).toContain('ONLY PRINTING');
    await waitForRunEnd(page);
    await expect(page.locator('#graphic-wrap')).toHaveClass(/hide/);

    await runSrc("import console\nname = console.input('NAME? ')\nprint('HI', repr(name))\n");
    await expect.poll(() => consoleText(page), { timeout: 60_000 }).toContain('NAME?');
    // Un-transformed, console.input returns a coroutine that never runs, so
    // NAME? is never printed and the poll above is what fails. This line
    // catches the other half: the program must be WAITING, not finished.
    await page.waitForTimeout(1500);
    expect(await consoleText(page)).not.toContain('HI');
  });
});

test.describe('#316 through Step through', () => {
  test.describe.configure({ timeout: 240_000 });

  async function stepToEnd(page, src) {
    await open(page, 'main', src);
    const on = await page.evaluate(() => !!(window.trinket && window.trinket.config &&
      window.trinket.config.stepDebugger && window.trinket.config.variableExplorer));
    test.skip(!on, 'stepDebugger + variableExplorer are off on this stack');
    await page.evaluate(() => document.getElementById('debug-start').click());
    await expect(page.locator('#debug-last')).toBeVisible({ timeout: 180_000 });
    await page.locator('#debug-last').click();
    // Recording switches to the Variables tab, which hides the Result pane and
    // leaves the figure's canvas at 0x0 until it is shown again.
    await page.getByText('Result', { exact: true }).first().click();
  }

  test('pylab draws in the pane', async ({ page }) => {
    await stepToEnd(page, PROGRAMS.pylab);
    await expect.poll(() => consoleText(page), { timeout: 30_000 }).toContain('FINI');
    await expectFigureInPane(page);
  });

  test('a helper-only package is loaded', async ({ page }) => {
    await stepToEnd(page, PROGRAMS.helper);
    await expect.poll(() => consoleText(page), { timeout: 30_000 }).toContain('sqrt(2) FINI');
  });

  test('a SyntaxError is reported as itself', async ({ page }) => {
    await stepToEnd(page, PROGRAMS.typo);
    await expect.poll(() => consoleText(page), { timeout: 30_000 }).toContain('SyntaxError');
    await expectRealSyntaxError(await consoleText(page));
  });
});
