import { test, expect } from '@playwright/test';

test('macOS app control switch persists and rejects unknown fields [AC:macos-app-control#AC-1]', async ({ page, request }) => {
  const initial = await request.patch('/api/app-control/settings', { data: { enabled: false } });
  expect(initial.ok()).toBeTruthy();
  await page.goto('/#/settings/tools');
  const card = page.locator('#card-appControl');
  await expect(card).toBeVisible();
  const toggle = card.locator('#field-appControlEnabled');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(async () => (await (await request.get('/api/app-control/settings')).json()).settings.enabled).toBe(true);
  await page.reload();
  await expect(page.locator('#field-appControlEnabled')).toBeChecked();
  await page.locator('#field-appControlEnabled').uncheck();
  await expect.poll(async () => (await (await request.get('/api/app-control/settings')).json()).settings.enabled).toBe(false);
  const invalid = await request.patch('/api/app-control/settings', { data: { command: '/bin/osascript' } });
  expect(invalid.status()).toBe(400);
  const unchanged = await (await request.get('/api/app-control/settings')).json();
  expect(unchanged.settings.enabled).toBe(false);
});
