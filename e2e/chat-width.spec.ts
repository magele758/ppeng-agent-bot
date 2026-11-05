import { test, expect } from '@playwright/test';

test('聊天宽度与留白可保存 [AC:chat-width#AC-1]', async ({ page }) => {
  let values: Record<string,string> = {};
  await page.route('**/api/user/preferences', async route => {
    if (route.request().method() === 'PATCH') Object.assign(values, route.request().postDataJSON().values);
    await route.fulfill({ json: { scope: 'width-test', values } });
  });
  await page.goto('/#/settings/general');
  const mode = page.locator('#chat-width-mode');
  await expect(mode).toHaveValue('center', { timeout: 5000 });
  await mode.selectOption('full');
  await page.locator('#chat-width-gap').fill('40');
  await expect.poll(() => values['lab.chatGutter']).toBe('40');
  await page.reload();
  await expect(mode).toHaveValue('full');
  await expect(page.locator('#chat-width-gap')).toHaveValue('40');
  await expect(page.locator('html')).toHaveAttribute('data-chat-width', 'full');
});
