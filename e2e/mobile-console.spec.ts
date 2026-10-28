import { test, expect } from '@playwright/test';

for (const width of [360, 390, 430]) {
  test(`mobile navigation and full-width chat at ${width} [AC:mobile-console#AC-1]`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('.play-sidebar')).toBeHidden();
    const main = await page.locator('.chat-panel:visible').boundingBox();
    expect(main!.width).toBeGreaterThan(width - 32);
    const nav = page.locator('.lab-rail__nav');
    for (const link of await nav.getByRole('link').all()) {
      await expect(link).toBeInViewport({ ratio: 1 });
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await link.click();
      await expect(link).toHaveAttribute('aria-current', 'page');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
}

test('mobile sessions preserve draft [AC:mobile-console#AC-2]', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const input = page.locator('.chat-composer-input:visible');
  await input.fill('手机端未发送草稿');
  const toggle = page.getByTestId('mobile-sessions-toggle');
  await toggle.click();
  await expect(page.locator('.play-sidebar')).toBeVisible();
  await expect(input).toBeHidden();
  await toggle.click();
  await expect(input).toHaveValue('手机端未发送草稿');
  await expect(input).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 390, height: 520 });
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(input).toHaveValue('手机端未发送草稿');
});

test('mobile settings and appearance tools [AC:mobile-console#AC-3]', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/#/settings');
  await expect(page.locator('.settings-nav')).toBeVisible();
  expect(await page.locator('.settings-nav').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByTestId('mobile-tools-toggle').click();
  const dialog = page.locator('.mobile-tools-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('button').first()).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('mobile-tools-toggle')).toBeFocused();
  const layout = page.locator('.settings-layout');
  expect(await layout.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('desktop keeps split layout [AC:mobile-console#AC-4]', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('.play-sidebar')).toBeVisible();
  await expect(page.getByTestId('mobile-sessions-toggle')).toBeHidden();
  const sidebar = await page.locator('.play-sidebar').boundingBox();
  const chat = await page.locator('.chat-panel:visible').boundingBox();
  expect(chat!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width - 1);
});

test('mobile saved desktop collapse keeps labels and session selection works [AC:mobile-console#AC-1] [AC:mobile-console#AC-2]', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { localStorage.setItem('lab.railCollapsed', '1'); localStorage.setItem('lab.locale', 'en'); });
  await page.goto('/');
  await expect(page.locator('.lab-rail__label').filter({ hasText: 'Knowledge & Memory' })).toBeVisible();
  await page.getByTestId('mobile-sessions-toggle').click();
  const row = page.locator('#sessionListMini .session-item__body:visible').first();
  if (await row.count()) {
    await row.click();
    await expect(page.locator('.play-sidebar')).toBeHidden();
    await expect(page.locator('.chat-composer-input:visible')).toBeInViewport();
  } else {
    await page.getByTestId('mobile-sessions-toggle').click();
    await expect(page.locator('.play-sidebar')).toBeHidden();
  }
});
