const { test, expect } = require('@playwright/test');

// #330: `#region` / `#endregion` comments fold, in every ACE Python-mode embed,
// alongside the colon folds ACE already had. Signed out, writes nothing: safe
// anywhere (ANON_ONLY=1).

const REGION = '#region setup\nball = 1\nv = 2\ndt = 0.01\n#endregion\n\ndef f(x):\n    return x\n';

async function open(page, type, src) {
  await page.goto('about:blank');
  await page.goto(`/embed/${type}#code=` + encodeURIComponent(src));
  await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 60_000 });
}

const widgetAt = (page, row) => page.evaluate((r) =>
  document.querySelector('.ace_editor').env.editor.getSession().getFoldWidget(r) || '', row);

const folds = (page) => page.evaluate(() =>
  document.querySelector('.ace_editor').env.editor.getSession().getAllFolds()
    .map((f) => [f.start.row, f.end.row]));

// Click the gutter arrow on `row`, the way a student folds.
async function clickFold(page, row) {
  await page.locator('.ace_gutter-cell').nth(row).locator('.ace_fold-widget').click();
}

for (const [type, offset, prefix] of [['python3', 0, ''], ['glowscript', 1, 'Web VPython 3.2\n']]) {
  test.describe(`#region folding in a ${type} embed (#330)`, () => {
    test('a #region line gets a fold arrow, and it folds through #endregion', async ({ page }) => {
      await open(page, type, prefix + REGION);
      await expect.poll(() => widgetAt(page, offset), { timeout: 10_000 }).toBe('start');

      await clickFold(page, offset);
      expect(await folds(page)).toEqual([[offset, offset + 4]]);
      // The setup lines are hidden; the code after the region is not.
      await expect(page.locator('.ace_line', { hasText: 'dt = 0.01' })).toHaveCount(0);
      await expect(page.locator('.ace_line', { hasText: 'def f(x):' })).toHaveCount(1);
    });

    test('colon blocks still fold as before', async ({ page }) => {
      await open(page, type, prefix + REGION);
      const defRow = offset + 6;
      await expect.poll(() => widgetAt(page, defRow), { timeout: 10_000 }).toBe('start');
      await clickFold(page, defRow);
      expect(await folds(page)).toEqual([[defRow, defRow + 1]]);
    });
  });
}
