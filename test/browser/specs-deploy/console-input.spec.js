const { test, expect } = require('@playwright/test');

// #324: console.input() (#86) on a deploy's DEFAULT runtime.
//
// Every other console.input test pins ?runtime=main, so none of them could see
// that a worker-default deploy sent these programs to the worker, which has no
// `console` module ("No module named 'console'"). These open a bare
// /embed/python3, exactly as a student's embed does. Signed out, writes nothing:
// safe anywhere (ANON_ONLY=1).

async function open(page, src, query) {
  await page.goto('about:blank');
  await page.goto('/embed/python3' + (query || '') + '#code=' + encodeURIComponent(src));
  await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 60_000 });
}

const outputText = (page) => page.evaluate(() => {
  const out = document.querySelector('#outputContainer');
  return out ? (out.innerText || '') : '';
});

async function answer(page, value) {
  await expect(page.locator('#console-output.console-active')).toBeVisible({ timeout: 180_000 });
  await page.locator('#console-output').click();
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

test.describe('console.input() on the default runtime (#324)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('reads a typed line, whatever runtime the deploy defaults to', async ({ page }) => {
    await open(page, 'import console\nname = console.input("your name? ")\nprint("hi", name, "FINI")\n');
    await page.locator('.run-it').first().click();
    await answer(page, 'Ada');
    await expect.poll(() => outputText(page), { timeout: 60_000 }).toContain('hi Ada FINI');
    expect(await outputText(page)).not.toContain("No module named 'console'");
    expect(await page.evaluate(() => window.__trinketRuntime), 'console input runs on the main thread').toBe('main');
  });

  // Only the ROUTING is asserted here. console.input() called from a helper is
  // a separate, older limitation: the async transform rewrites main.py only,
  // so the helper's call returns an un-awaited coroutine (#326). What #324
  // fixes is that a helper's `import console` no longer sends the whole
  // program to the worker to die on the import.
  test('a helper file importing console keeps the program on the main thread', async ({ page }) => {
    await open(page, 'import helper\nprint("helper loaded", helper.ok, "FINI")\n\n----{helper.py}----\n' +
                     'import console\nok = hasattr(console, "input")\n');
    await page.locator('.run-it').first().click();
    await expect.poll(() => outputText(page), { timeout: 180_000 }).toContain('helper loaded True FINI');
    expect(await outputText(page)).not.toContain("No module named 'console'");
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });

  test('?runtime=worker cannot send it to the worker, and says so', async ({ page }) => {
    await open(page, 'import console\nname = console.input("your name? ")\nprint("hi", name, "FINI")\n', '?runtime=worker');
    await page.locator('.run-it').first().click();
    await answer(page, 'Ada');
    await expect.poll(() => outputText(page), { timeout: 60_000 }).toContain('hi Ada FINI');
    expect(await outputText(page)).toContain('?runtime=worker could not be honoured here');
  });
});
