import { test, expect } from '@playwright/test';

const EXPERIMENTAL = [
  'modelFallback',
  'compact',
  'goalVerify',
  'agentLoopEngine',
  'sandboxCloudflare',
  'dynTools',
  'discovery',
  'langfuse'
] as const;

test('experimental menu is visible without show-advanced [AC:experimental-settings#AC-1] [AC:experimental-settings#AC-2] [AC:experimental-settings#AC-3]', async ({
  page
}) => {
  await page.addInitScript(() => window.localStorage.removeItem('lab.settings.advanced'));
  await page.goto('/#/settings/models');
  const nav = page.getByRole('navigation', { name: '设置分类' });
  await expect(nav.getByRole('button', { name: '模型' })).toBeVisible();
  await expect(nav.getByRole('button', { name: '集成与可观测' })).toBeVisible();
  await expect(nav.getByRole('button', { name: '实验特性' })).toBeVisible();
  await expect(page.getByTestId('advanced-toggle')).not.toBeChecked();

  await nav.getByRole('button', { name: '实验特性' }).click();
  await expect(page).toHaveURL(/#\/settings\/experimental$/);
  for (const id of EXPERIMENTAL) {
    await expect(page.locator(`#setting-${id}`)).toBeVisible();
  }
  for (const id of EXPERIMENTAL) {
    const rowSwitch = page.getByTestId(`experiment-switch-${id}`);
    await expect(rowSwitch).toBeVisible();
    await expect(rowSwitch).toHaveAttribute('role', 'switch');
  }

  await page.goto('/#/settings/integrations');
  await expect(page.getByTestId('advanced-toggle')).not.toBeChecked();
  for (const id of ['jev', 'langfuse']) {
    await expect(page.locator(`#setting-${id}`)).toHaveCount(0);
  }
  await expect(page.locator('#gw-feishu-token')).toBeVisible();
  await expect(page.locator('#gw-webhook-senders')).toHaveCount(0);
});
