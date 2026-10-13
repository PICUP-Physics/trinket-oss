const { test, expect } = require('@playwright/test');

// The Web VPython (glowscript) Stop button, end to end against the real
// runtime, including the ↻ Run look it takes while the editor holds something
// other than what runs. Needs the local stack built from this branch: the
// Dockerfile vendors the 3.2.3 runtime and builds the CSS, and the ↻ Run look
// needs the stylesheet built from this branch too (test/browser/README.md covers
// the stack). Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const LOOP = 'Web VPython 3.2\nb = box()\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    b.rotate(angle=0.05, axis=vec(0, 1, 0))\n    print(n)\n';
const FINITE = 'Web VPython 3.2\nsphere()\nfor i in range(3):\n    rate(10)\n';
const BROKEN = 'Web VPython 3.2\nwhile True\n    rate(30)\n';
// The same loop with rate() reached through a module name instead of the global.
const NAMESPACED = 'Web VPython 3.2\nimport vpython as vp\nb = vp.box()\nn = 0\nwhile True:\n    vp.rate(30)\n    n = n + 1\n    print(n)\n';
// A button whose handler raises, beside a main loop that keeps going.
const HANDLER_ERROR = 'Web VPython 3.2\nb = box()\ndef boom(evt):\n    raise ValueError("boom")\nbutton(bind=boom, text="Boom")\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    print(n)\n';
// The same printing loop saying A or B, so that what a run printed shows which program it was.
const printing = (letter) => 'Web VPython 3.2\nb = box()\nwhile True:\n    rate(30)\n    print("' + letter + '")\n';
const PRINT_A = printing('A');
const PRINT_B = printing('B');

// A Stop within 500 ms of a Run is ignored as the second click of a double-click
// on Run (STOP_GRACE_MS in glowscript-run-state.js), so these tests wait past it.
const PAST_DOUBLE_CLICK_GUARD_MS = 600;

// The editor's whole text, as an edit or an undo leaves it: ACE's setValue fires the same
// change events as typing does.
async function setCode(page, code) {
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
}

// The text main.py's editor holds (the first one; the tests that read it have one file).
const getCode = (page) => page.evaluate(() => document.querySelector('.ace_editor').env.editor.getValue());

async function open(page, code) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor')).toBeVisible();
  await setCode(page, code);
}

async function run(page, code) {
  await open(page, code);
  await page.locator('.run-it').first().click();
}

// A saved trinket, made through the API, so that its editor has an original to go back to.
async function createTrinket(page, code, name) {
  const res = await page.request.post('/api/trinkets', { data: { lang: 'glowscript', code, name } });
  expect(res.ok(), 'trinket create should succeed').toBeTruthy();
  const body = await res.json();
  return (body.data || body).shortCode;
}

// The Reset control as a person uses it: the menu, Reset, and "Yes, I am sure." in the
// confirmation. The original comes back into the editor a moment later (a draft is
// discarded first), so a test waits for the text it expects.
async function resetThroughTheUI(page) {
  await page.locator('.left-off-canvas-toggle').click();
  await page.locator('a.reset-it').click();
  await page.locator('#confirmResetModal [data-action="code.confirm-reset"]').click();
}

const runControl = (page) => page.locator('.run-it').first();
// Fails fast if the runner or its print area is missing, instead of at the test timeout.
const printed = (page) => page.frameLocator('#glowscriptOutput').locator('textarea#print').inputValue({ timeout: 5_000 });
// For expect.poll. The print area appears only at the program's first print(),
// after the runtime loads, and a generator that rejects ends the poll on its
// first call (Playwright 1.48) instead of being retried. So a read that fails
// counts as no output yet, and the poll's own timeout decides.
const printedLines = async (page) => (await printed(page).catch(() => '')).split('\n').filter(Boolean).length;

// A control's rendered size, to the sub-pixel (offsetWidth would round it).
const size = async (locator) => {
  const { width, height } = await locator.boundingBox();
  return { width, height };
};
// Within half a pixel (numDigits 0). The height is held too: a label that wrapped
// under its icon would make the control 16 px taller.
function expectSameSize(actual, expected, when) {
  expect(actual.width, 'width ' + when).toBeCloseTo(expected.width, 0);
  expect(actual.height, 'height ' + when).toBeCloseTo(expected.height, 0);
}

// The Run control keeps the size it has as Run through a run and a Stop, so nothing
// in the toolbar moves. Stop is wider than Run (about 4 px with the label showing,
// about 1 px with only the icon) and takes the difference from the control's padding.
async function expectSizeHeld(page, { labelShown }) {
  await open(page, LOOP);
  const label = runControl(page).locator('label');
  if (labelShown) { await expect(label).toBeVisible(); } else { await expect(label).toBeHidden(); }
  const idle = await size(runControl(page));
  expect(idle.width, 'the control is rendered').toBeGreaterThan(20);

  await runControl(page).click();
  await expect(runControl(page)).toHaveClass(/run-state-running/);
  expectSameSize(await size(runControl(page)), idle, 'as soon as it runs');

  await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
  expectSameSize(await size(runControl(page)), idle, 'while the program prints');

  await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
  await runControl(page).click();
  await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
  await expect(label).toHaveText('Run');
  expectSameSize(await size(runControl(page)), idle, 'after Stop');
}

// Where the content sits in the control: the space left of the icon and the space right
// of what comes last (the label, or the icon where the label is hidden), the margins
// counted in (the icon has one of 1 px on its right). Equal, within half a pixel, is
// centered.
const gaps = (locator) => locator.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const icon = el.querySelector('i');
  const label = el.querySelector('label');
  const last = label.getBoundingClientRect().width > 0 ? label : icon;
  const margin = (node, side) => parseFloat(getComputedStyle(node)['margin' + side]) || 0;
  return {
    left: icon.getBoundingClientRect().left - margin(icon, 'Left') - box.left,
    right: box.right - (last.getBoundingClientRect().right + margin(last, 'Right')),
  };
});
function expectCentered(actual, when) {
  expect(Math.abs(actual.left - actual.right), 'content centered ' + when).toBeLessThan(0.5);
}

// The control keeps its size, and its content stays centered, from Run through Stop, ↻ Run,
// Stop again and Run again. ↻ Run's content is not Stop's, so the padding follows it.
async function expectSizeHeldThroughAnEdit(page, { labelShown }) {
  await open(page, PRINT_A);
  const control = runControl(page);
  const label = control.locator('label');
  if (labelShown) { await expect(label).toBeVisible(); } else { await expect(label).toBeHidden(); }
  const idle = await size(control);
  expect(idle.width, 'the control is rendered').toBeGreaterThan(20);
  expectCentered(await gaps(control), 'as Run');

  await control.click();
  await expect(control).toHaveClass(/run-state-running/);
  await expect(control).not.toHaveClass(/run-state-edited/);
  expectSameSize(await size(control), idle, 'as Stop');
  expectCentered(await gaps(control), 'as Stop');
  const stop = await size(control);

  await setCode(page, PRINT_B);
  await expect(control).toHaveClass(/run-state-edited/);
  expectSameSize(await size(control), idle, 'as ↻ Run');
  expectCentered(await gaps(control), 'as ↻ Run');

  await setCode(page, PRINT_A);
  await expect(control).not.toHaveClass(/run-state-edited/);
  expectSameSize(await size(control), idle, 'as Stop again');
  expectCentered(await gaps(control), 'as Stop again');
  // Stop again is the Stop it was, to the layout engine's grid (1/64 px), not only to half a pixel.
  expect((await size(control)).width, 'as Stop again, exactly').toBeCloseTo(stop.width, 3);

  await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
  await control.click();
  await expect(control).not.toHaveClass(/run-state-/, { timeout: 5_000 });
  await expect(label).toHaveText('Run');
  expectSameSize(await size(control), idle, 'as Run again');
  expectCentered(await gaps(control), 'as Run again');
}

test.describe('Web VPython Stop button', () => {
  test('Run turns into Stop, with the strip, while a program runs', async ({ page }) => {
    await run(page, LOOP);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page).locator('label')).toHaveText('Stop');
    await expect(runControl(page).locator('svg.run-stop-trace')).toBeVisible();
  });

  test('the control keeps its width through Run, Stop and Run again', async ({ page }) => {
    await expectSizeHeld(page, { labelShown: true });
  });

  // Below the large breakpoint the editor's label is hidden and only the icon shows;
  // Stop's icon is then about 1 px wider than Run's, and the same rule has to hold.
  test('the control keeps its width through Run, Stop and Run again when only the icon shows', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 720 });
    await expectSizeHeld(page, { labelShown: false });
  });

  test('Stop freezes the program in place and returns to Run', async ({ page }) => {
    await run(page, LOOP);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');
    await expect(runControl(page).locator('svg.run-stop-trace')).toBeHidden();

    // Parked, not torn down: the runner is still there and no stopped note shows.
    await expect(page.locator('#glowscriptOutput')).toHaveCount(1);
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);

    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
  });

  // `import vpython as vp` makes the loop call vp.rate(), not the global rate().
  // Stop must park that call too, in place and not by tearing the runner down.
  test('a namespaced vp.rate() loop stops in place', async ({ page }) => {
    await run(page, NAMESPACED);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');

    // Parked, not torn down: no stopped note, and the output no longer moves.
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
  });

  // Save asks the runner for a thumbnail. The runtime's screenshot goes through
  // the waits that keep a stopped program parked, so the runner lets new waits
  // through while the screenshot is taken.
  test('a stopped program still answers a snapshot request', async ({ page }) => {
    await run(page, LOOP);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');
    // Parked, not torn down: the runner that has to answer is still there.
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);

    const snapshot = await page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no snapshot within 5 s')), 5_000);
      window.addEventListener('message', function onMessage(e) {
        let data;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        if (data && data.snapshot) {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(data.snapshot);
        }
      });
      document.getElementById('glowscriptOutput').contentWindow.postMessage('glowscript.snapshot', '*');
    }));
    expect(snapshot).toMatch(/^data:image\/png/);
  });

  // An error raised outside the program's main flow leaves that flow running,
  // so the control must stay Stop. Whether 3.2.3 reports a handler's error to
  // the page at all is unconfirmed; this pins the outcome either way, and does
  // not look at the error banner.
  test('an error in an event handler does not end a running program', async ({ page }) => {
    await run(page, HANDLER_ERROR);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await page.frameLocator('#glowscriptOutput').getByRole('button', { name: 'Boom' }).click();
    // Half a second of the loop going on: time for any error report to arrive.
    const afterClick = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(afterClick + 15);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page).locator('label')).toHaveText('Stop');

    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
  });

  test('a program that finishes returns to Run on its own', async ({ page }) => {
    await run(page, FINITE);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
    // Finished, not errored or given up loading: no alert banner was raised.
    await expect(page.locator('#statusMessages')).toHaveCount(0);
  });

  test('a compile error returns to Run', async ({ page }) => {
    await run(page, BROKEN);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
    // The program's error banner, not the runtime-load failure one.
    await expect(page.locator('#statusMessages').first()).toBeAttached();
    await expect(page.getByText(/could not be loaded/)).toHaveCount(0);
  });

  // Enter on the output-only toolbar's <button> used to dispatch twice: embed.js
  // acts on the keypress and the browser then synthesizes a click. A Stop before
  // the runner is ready tears the run down at once, so the second dispatch (by
  // then Run again) restarted the program; glowscript.js now cancels that click.
  // The page is kept from ever seeing the runner's ready message, so this test
  // always takes that teardown path instead of racing the runtime's load time.
  test('Enter on the output-only Stop button stops the program instead of restarting it', async ({ page }) => {
    const shortCode = await createTrinket(page, LOOP, 'stop-enter-' + Date.now());

    await page.addInitScript(() => {
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && e.data.includes('glowscript.ready')) { e.stopImmediatePropagation(); }
      }, true);
    });

    await page.goto('/embed/glowscript/' + shortCode + '?outputOnly=true');
    const control = page.locator('button.run-it');
    await expect(control).toBeVisible();
    const idle = await size(control);
    expect(idle.width, 'the control is rendered').toBeGreaterThan(20);

    await control.press('Enter');                                          // Run
    await expect(control).toHaveClass(/run-state-running/);
    expectSameSize(await size(control), idle, 'while running');
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    await expect(control.locator('label')).toHaveText('Stop');
    // runCode() moved focus to #honeypot; press() focuses the control again.
    await control.press('Enter');                                          // Stop
    await expect(page.locator('.glowscript-stopped-note')).toBeVisible();  // the teardown path ran
    await expect(control).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    expectSameSize(await size(control), idle, 'after the teardown');
    await page.waitForTimeout(1_500);
    await expect(control, 'Stop must not restart the program').not.toHaveClass(/run-state-/);
  });

  // "Edit, then Run" is one click: while the editor holds something other than what
  // runs, the control reads ↻ Run, and a click on it runs the changes.
  test('editing a running program turns Stop into ↻ Run, and one click runs the changes', async ({ page }) => {
    await run(page, PRINT_A);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    expect(await printed(page)).toContain('A');
    const control = runControl(page);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    const stop = await size(control);

    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Run');
    await expect(control).toHaveAttribute('data-action', 'code.run');
    await expect(control).toHaveAttribute('aria-label', 'Run your changes');
    await expect(control).not.toHaveAttribute('aria-disabled');
    expectSameSize(await size(control), stop, 'as ↻ Run');
    // Still running the old program, until it is told otherwise.
    const printedBefore = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(printedBefore);

    await control.click();
    // Stop again, for the new run, with no Stop and no second click in between.
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Stop');
    await expect(control).toHaveAttribute('data-action', 'code.stop');
    expectSameSize(await size(control), stop, 'as Stop again');
    // The new program's output, and none of the old one's.
    await expect.poll(() => printed(page).catch(() => ''), { timeout: 60_000 }).toContain('B');
    expect(await printed(page)).not.toContain('A');
  });

  test('undoing the edit, back to the exact text that runs, is Stop again', async ({ page }) => {
    await run(page, PRINT_A);
    const control = runControl(page);
    await expect(control).toHaveClass(/run-state-running/);

    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);
    await setCode(page, PRINT_A);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Stop');
    await expect(control).toHaveAttribute('data-action', 'code.stop');

    // The same with a person's keystrokes: type a character, then take it back.
    await page.locator('.ace_content').click();
    await page.keyboard.type('#');
    await expect(control).toHaveClass(/run-state-edited/);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control.locator('label')).toHaveText('Stop');
  });

  // The text that runs is every file, so an edit in a file that is not showing counts too.
  test('an edit in a file that is not showing counts, and so does undoing it', async ({ page }) => {
    await open(page, PRINT_A);
    // A second file, behind main.py's tab. _files is the code editor's own list.
    await page.evaluate(() => {
      $('#editor').data('trinket-codeEditor').addFile({ name: 'data.py', content: 'x = 1\n' });
    });
    const setSecondFile = (src) => page.evaluate((text) => {
      $('#editor').data('trinket-codeEditor')._files[1].editor.setValue(text);
    }, src);
    const control = runControl(page);
    await control.click();
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);

    await setSecondFile('x = 2\n');
    await expect(control).toHaveClass(/run-state-edited/);
    await setSecondFile('x = 1\n');
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control.locator('label')).toHaveText('Stop');
  });

  // The stop is under way, so the program is already being ended: an edit then has no
  // run to offer a restart of, and after the stop the control is plain Run. The page is
  // kept from ever seeing the runner's confirmation, so the control stays Stopping until
  // the controller's own 2 s fallback ends it, which leaves the time to edit.
  test('an edit while the program is stopping does not offer ↻ Run, and the stop ends in plain Run', async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && e.data.includes('glowscript.stopped')) { e.stopImmediatePropagation(); }
      }, true);
    });
    await run(page, PRINT_A);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    const control = runControl(page);
    await control.click();
    await expect(control).toHaveClass(/run-state-stopping/);

    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-stopping/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Stop');
    await expect(control).toHaveAttribute('aria-label', 'Stopping program');
    await expect(control).toHaveAttribute('data-action', 'code.stop');

    // After the stop it is plain Run.
    await expect(control).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(control.locator('label')).toHaveText('Run');
    await expect(control.locator('i')).toHaveClass('fa fa-play');
    await expect(control).toHaveAttribute('data-action', 'code.run');
    await expect(control).not.toHaveAttribute('aria-label');
  });

  // The first click runs the changes and the control is Stop at once, so a second click
  // within a double-click's time lands on Stop, which the controller ignores for 500 ms
  // after a launch. If the control were still ↻ Run, it would run a third time instead.
  test('a second click right after ↻ Run lands on Stop within the double-click guard, and the new run goes on', async ({ page }) => {
    await run(page, PRINT_A);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    const control = runControl(page);
    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);

    // Two clicks in one task, as fast as a double-click can be.
    const actions = await control.evaluate((el) => {
      el.click();
      const afterFirst = el.getAttribute('data-action');
      el.click();
      return { afterFirst, afterSecond: el.getAttribute('data-action') };
    });
    expect(actions).toEqual({ afterFirst: 'code.stop', afterSecond: 'code.stop' });

    await expect(control).toHaveClass(/run-state-running/);
    await expect.poll(() => printed(page).catch(() => ''), { timeout: 60_000 }).toContain('B');
    // Past the guard, the new run is still going: not stopped, not torn down.
    await page.waitForTimeout(PAST_DOUBLE_CLICK_GUARD_MS);
    const lines = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(lines + 5);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
  });

  // Ctrl/Cmd-Enter in the editor is the other way to run the changes, and it does not
  // go through the control, so the control is told about the new run by runCode().
  test('Ctrl/Cmd-Enter after an edit runs the changes, and the control is Stop for the new run', async ({ page }) => {
    await run(page, PRINT_A);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    const control = runControl(page);
    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);

    await page.locator('.ace_content').click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Stop');
    await expect(control).toHaveAttribute('data-action', 'code.stop');
    await expect.poll(() => printed(page).catch(() => ''), { timeout: 60_000 }).toContain('B');
    expect(await printed(page)).not.toContain('A');
  });

  test('the control keeps its size, with its content centered, through Stop, ↻ Run, Stop and Run', async ({ page }) => {
    await expectSizeHeldThroughAnEdit(page, { labelShown: true });
  });

  test('the control keeps its size, with its content centered, through Stop, ↻ Run, Stop and Run when only the icon shows', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 720 });
    await expectSizeHeldThroughAnEdit(page, { labelShown: false });
  });

  // ↻ Run is the normal Run look, not Stop's red, in every state the pointer puts it in;
  // the strip keeps lapping, in gray. Both classes are on the control, so this is the
  // stylesheet's cascade checked against the browser's: it needs the CSS built from this branch.
  test('↻ Run looks like Run, not Stop: gray at rest, blue on hover, with the strip lapping in gray', async ({ page }) => {
    const RED = 'rgb(198, 40, 40)';
    const TEXT_GRAY = 'rgb(82, 82, 82)';
    const STRIP_GRAY = 'rgb(107, 107, 107)';
    const BLUE = 'rgb(0, 138, 255)';
    const WHITE = 'rgb(255, 255, 255)';
    const CLEAR = 'rgba(0, 0, 0, 0)';

    await run(page, PRINT_A);
    const control = runControl(page);
    const look = () => control.evaluate((el) => {
      const css = (node, prop) => getComputedStyle(node)[prop];
      const rect = el.querySelector('.run-stop-trace rect');
      return {
        text: css(el, 'color'),
        icon: css(el.querySelector('i'), 'color'),
        label: css(el.querySelector('label'), 'color'),
        fill: css(el, 'backgroundColor'),
        strip: css(rect, 'stroke'),
        lap: css(rect, 'animationName'),
        dashes: css(rect, 'strokeDasharray'),
        stroke: css(rect, 'strokeWidth'),
      };
    });
    const pointerAway = () => page.mouse.move(5, 400);

    await expect(control).toHaveClass(/run-state-running/);
    await pointerAway();
    // Stop, for contrast: red.
    await expect.poll(look).toMatchObject({ text: RED, icon: RED, label: RED, strip: RED, fill: CLEAR });

    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);
    // ↻ Run at rest: the toolbar's own gray, nothing filled, the strip lapping in its own gray.
    await expect.poll(look).toMatchObject({ text: TEXT_GRAY, icon: TEXT_GRAY, label: TEXT_GRAY, fill: CLEAR, strip: STRIP_GRAY, lap: 'run-stop-lap' });
    await expect(control.locator('svg.run-stop-trace')).toBeVisible();

    // On hover: what Run does, a blue fill with white content, the strip white on it.
    await control.hover();
    await expect.poll(look).toMatchObject({ text: WHITE, icon: WHITE, label: WHITE, fill: BLUE, strip: WHITE, lap: 'run-stop-lap' });

    // With reduced motion the strip is a still outline, in the same gray.
    await pointerAway();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(look).toMatchObject({ text: TEXT_GRAY, strip: STRIP_GRAY, lap: 'none', dashes: 'none', stroke: '1.5px' });
  });

  // A Reset puts the saved text into the editor without a change event, and it leaves the
  // running program alone. So the control has to be worked out again from what the editor
  // holds and what runs, in both directions.
  test('a Reset back to the text that runs is Stop again', async ({ page }) => {
    const shortCode = await createTrinket(page, PRINT_A, 'stop-reset-back-' + Date.now());
    await page.goto('/embed/glowscript/' + shortCode);
    await expect(page.locator('.ace_editor')).toBeVisible();
    expect(await getCode(page), 'the saved trinket opens as A').toBe(PRINT_A);
    const control = runControl(page);

    await control.click();
    await expect(control).toHaveClass(/run-state-running/);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);

    await resetThroughTheUI(page);
    await expect.poll(() => getCode(page), { message: 'the Reset puts A back' }).toBe(PRINT_A);
    // A runs on, and the editor holds it again: Stop, with nothing to restart.
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control.locator('label')).toHaveText('Stop');
    await expect(control).toHaveAttribute('data-action', 'code.stop');
    const lines = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(lines + 5);
  });

  test('a Reset away from the text that runs is ↻ Run', async ({ page }) => {
    const shortCode = await createTrinket(page, PRINT_A, 'stop-reset-away-' + Date.now());
    await page.goto('/embed/glowscript/' + shortCode);
    await expect(page.locator('.ace_editor')).toBeVisible();
    const control = runControl(page);

    await setCode(page, PRINT_B);
    await control.click();
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect.poll(() => printed(page).catch(() => ''), { timeout: 60_000 }).toContain('B');

    await resetThroughTheUI(page);
    await expect.poll(() => getCode(page), { message: 'the Reset puts A back' }).toBe(PRINT_A);
    // B runs on, and the editor no longer holds it: ↻ Run, which runs what is there.
    await expect(control).toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Run');
    await expect(control).toHaveAttribute('data-action', 'code.run');
    await expect(control).toHaveAttribute('aria-label', 'Run your changes');
    const lines = await printedLines(page);
    await expect.poll(() => printedLines(page)).toBeGreaterThan(lines + 5);

    await control.click();
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect.poll(() => printed(page).catch(() => ''), { timeout: 60_000 }).toContain('A');
    expect(await printed(page)).not.toContain('B');
  });

  // The Reset control is one way into the editor's reset(); a restored session and the
  // remix version toggle call it without the control, and the look has to follow there too.
  test('the editor reset() called on its own, as a restored session or the remix toggle does, follows the text', async ({ page }) => {
    await run(page, PRINT_A);
    const control = runControl(page);
    await expect(control).toHaveClass(/run-state-running/);
    await expect(control).not.toHaveClass(/run-state-edited/);

    await setCode(page, PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);
    await page.evaluate((code) => window.TrinketApp.reset({ code }), PRINT_A);
    expect(await getCode(page), 'the reset puts A back').toBe(PRINT_A);
    await expect(control).not.toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Stop');

    await page.evaluate((code) => window.TrinketApp.reset({ code }), PRINT_B);
    expect(await getCode(page), 'the reset puts B in').toBe(PRINT_B);
    await expect(control).toHaveClass(/run-state-edited/);
    await expect(control.locator('label')).toHaveText('Run');
  });
});
