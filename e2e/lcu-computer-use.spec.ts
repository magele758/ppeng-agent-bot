import { test, expect } from '@playwright/test';

test('LCU switch persists and settings API validates input [AC:lcu-computer-use#AC-1] [AC:lcu-computer-use#AC-6]', async ({ page, request }) => {
  const initial = await request.patch('/api/computer-use/settings', { data: { enabled: false } });
  expect(initial.ok()).toBeTruthy();
  await page.goto('/#/settings/tools');
  const card = page.locator('#card-computerUse');
  await expect(card).toBeVisible();
  const toggle = card.locator('#field-computerUseEnabled');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(async () => (await (await request.get('/api/computer-use/settings')).json()).settings.enabled).toBe(true);
  await page.reload();
  await expect(page.locator('#field-computerUseEnabled')).toBeChecked();
  await page.locator('#field-computerUseEnabled').uncheck();
  await expect.poll(async () => (await (await request.get('/api/computer-use/settings')).json()).settings.enabled).toBe(false);
  const invalid = await request.patch('/api/computer-use/settings', { data: { command: 'relative-command' } });
  expect(invalid.status()).toBe(400);
  const unchanged = await (await request.get('/api/computer-use/settings')).json();
  expect(unchanged.settings.command.startsWith('/')).toBe(true);
});
