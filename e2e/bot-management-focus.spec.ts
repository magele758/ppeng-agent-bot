import { test, expect } from '@playwright/test';

test('Bot management starts with searchable cards and only the chosen Bot configuration [AC:bot-entry-simplification#AC-4]', async ({ page }) => {
  await page.goto('/#/agents/bots');
  const view = page.locator('#botsView');
  await expect(view.getByRole('searchbox', { name: '搜索 Bot' })).toBeVisible();
  await expect(view.getByText('团队工作', { exact: true })).toHaveCount(0);
  await expect(view.getByText('运行限制', { exact: true })).toHaveCount(0);
  await expect(view.getByTestId('bot-group-open')).toHaveCount(0);
  await expect(view.getByTestId('bot-detail')).toHaveCount(0);
  const card = view.locator('[data-testid^="bot-card-"]').first();
  const name = await card.locator('.ag-card__title').innerText();
  await view.getByRole('searchbox', { name: '搜索 Bot' }).fill(name);
  await card.click();
  await expect(view.getByTestId('bot-detail').getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(view.getByTestId('bot-detail')).toHaveCount(1);
});

test('Bot creation is a focused panel with cancel, failure and one successful result [AC:bot-entry-simplification#AC-3]', async ({ page }) => {
  const { bots } = await (await page.request.get('/api/bots')).json();
  const base = bots[0];
  expect(base).toBeTruthy();
  let attempts = 0;
  let created = false;
  const name = 'Focused creation probe';
  await page.route('**/api/bots', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { bots: created ? [...bots, { ...base, id: 'focused-probe', name }] : bots } });
    } else if (route.request().method() === 'POST') {
      attempts++;
      if (attempts === 1) await route.fulfill({ status: 503, json: { error: 'Probe unavailable' } });
      else { created = true; await route.fulfill({ status: 201, json: { bot: { ...base, id: 'focused-probe', name } } }); }
    } else await route.continue();
  });
  await page.goto('/#/agents/bots');
  const view = page.locator('#botsView');
  await page.getByTestId('bot-create-open').click();
  const form = page.getByRole('form', { name: '新建 Bot' });
  await expect(form).toBeVisible();
  await expect(view.getByRole('searchbox')).toHaveCount(0);
  await expect(view.locator('[data-testid^="bot-card-"]')).toHaveCount(0);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  expect(attempts).toBe(0);
  await expect(view.getByRole('searchbox')).toBeVisible();
  await page.getByTestId('bot-create-open').click();
  await expect(form.getByTestId('bot-create-submit')).toBeDisabled();
  await form.getByTestId('bot-create-name').fill(name);
  await form.getByTestId('bot-create-submit').click();
  await expect(form.getByRole('alert')).toContainText('Probe unavailable');
  expect(created).toBe(false);
  await expect(form).toBeVisible();
  await form.getByTestId('bot-create-submit').click();
  await expect(view.getByTestId('bot-card-focused-probe')).toBeVisible();
  await expect(view.getByTestId('bot-card-focused-probe')).toHaveCount(1);
  expect(attempts).toBe(2);
  await expect(form).toHaveCount(0);
});
