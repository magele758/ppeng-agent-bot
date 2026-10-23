import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lab.locale', 'zh');
    localStorage.removeItem('lab.settings.advanced');
  });
  await request.patch('/api/jev/settings', { data: { baseUrl: '', clearApiKey: true, model: 'jev-latest', profile: 'off', armed: false } });
});

test('Jev is configurable under models even while off, and search has one entry [AC:jev-model-settings#AC-1]', async ({ page }) => {
  await page.goto('/#/settings/models');
  await expect(page.locator('#field-jevBaseUrl')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#field-jevApiKey')).toBeVisible();
  await expect(page.locator('#field-jevModel')).toBeVisible();
  await expect(page.getByTestId('advanced-toggle')).not.toBeChecked();
  await page.goto('/#/settings/experimental');
  await expect(page.locator('#setting-jev')).toHaveCount(0);
  await page.locator('#settingsSearch').fill('jev');
  await expect(page.locator('#setting-jev')).toHaveCount(1);
  await expect(page.locator('#field-jevBaseUrl')).toBeVisible();
});

test('connection saves while off, keeps its secret private and probes without enabling [AC:jev-model-settings#AC-2]', async ({ page, request }) => {
  await page.goto('/#/settings/models');
  const card = page.locator('#setting-jev');
  await expect(page.locator('#field-jevBaseUrl')).toBeVisible({ timeout: 3000 });
  await page.locator('#field-jevBaseUrl').fill('https://jev.example.test');
  await page.locator('#field-jevApiKey').fill('test-only-jev-key');
  await page.locator('#field-jevModel').fill('jev-test');
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  const saved = await (await request.get('/api/jev/settings')).json();
  expect(saved.settings.apiKeySet).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('test-only-jev-key');
  expect(saved.settings.armed).toBe(false);
  await page.reload();
  await expect(page.locator('#field-jevBaseUrl')).toHaveValue('https://jev.example.test');
  await expect(page.locator('#field-jevModel')).toHaveValue('jev-test');
  await expect(page.locator('#field-jevApiKey')).toHaveValue('');
  await page.route('**/api/jev/probe', async route => {
    expect(route.request().postDataJSON()).toEqual({ baseUrl: 'https://jev.example.test', model: 'jev-test' });
    await route.fulfill({ json: { ok: true } });
  });
  await card.getByRole('button', { name: '测试连接' }).click();
  await expect(card.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible();
  expect((await (await request.get('/api/jev/settings')).json()).settings.armed).toBe(false);
  await page.locator('#field-jevArmed').check();
  await expect(card.getByTestId('jev-effective-state')).toHaveText('已接入评估');
  await page.locator('#field-jevArmed').uncheck();
  await expect(card.getByTestId('jev-effective-state')).toHaveText('已关闭，不调用评估模型');
  await expect(page.locator('#field-jevBaseUrl')).toBeVisible();
});

test('enabled and effective states are distinct, and failed saves roll back [AC:jev-model-settings#AC-3]', async ({ page, request }) => {
  await page.goto('/#/settings/models');
  const card = page.locator('#setting-jev');
  const toggle = page.locator('#field-jevArmed');
  await expect(toggle).toBeVisible({ timeout: 3000 });
  await toggle.check();
  await expect(card.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(card.getByTestId('jev-effective-state')).toHaveText('已开启，等待配置连接');
  await request.patch('/api/jev/settings', { data: { baseUrl: 'https://jev.example.test', profile: 'mini' } });
  await page.reload();
  await expect(card.getByTestId('jev-effective-state')).toHaveText('已开启，尚未选择评估环节');
  await page.route('**/api/jev/settings', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, json: { error: 'test-save-failed' } }) : route.continue());
  await toggle.uncheck();
  await expect(card.getByRole('alert')).toContainText('test-save-failed');
  await expect(toggle).toBeChecked();
  await expect(card.getByTestId('jev-effective-state')).toHaveText('已开启，尚未选择评估环节');
});
