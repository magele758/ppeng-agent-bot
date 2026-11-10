import { expect, test } from '@playwright/test';

test('recover a broken entry bundle at the original Bot URL [AC:lab-bootstrap-retry#AC-1]', async ({ page }) => {
  await page.route(/\/app\/page-[^/]+\.js$/, route => route.abort());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { loginRequired: true, providers: ['google'] } }));
  await page.goto('/?labBuild=old#/bot', { waitUntil: 'commit' });
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 25000 });
  expect(new URL(page.url()).hash).toBe('#/bot');
});

test('persistent entry failure stops and supports manual retry [AC:lab-bootstrap-retry#AC-2]', async ({ page }) => {
  const broken = /\/chunks\/webpack-[^/]+\.js/;
  await page.route(broken, route => route.abort());
  await page.route('**/api/auth/me', route => route.fulfill({ json: { loginRequired: true, providers: [] } }));
  await page.goto('/#/bot', { waitUntil: 'commit' });
  await expect(page.locator('[data-boot-error]')).toBeVisible({ timeout: 35000 });
  await page.unroute(broken);
  await page.locator('form[data-auth-reload] button').click();
  await expect(page.locator('.login-card')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/bot');
});
