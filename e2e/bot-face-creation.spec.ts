import { test as base, expect } from '@playwright/test';

const test = base.extend<{ originalBot: { id: string; name: string } }>({
  originalBot: async ({ request }, use) => {
    // Establish the real built-in conversation even when this test runs alone.
    // Hidden ordinary Bots still consume roster capacity, so do not leak one per run.
    const response = await request.get('/api/bot-work/default');
    expect(response.ok()).toBeTruthy();
    const { bot } = await response.json();
    await use(bot);
  }
});

for (const entry of ['chat', 'management'] as const) {
  test.describe(entry, () => {
  test('face-first fields open immediately [AC:bot-face-first-creation#AC-1] [AC:bot-face-first-creation#AC-2]', async ({ page }) => {
    await page.goto(entry === 'chat' ? '/#/bot' : '/#/agents/bots');
    if (entry === 'chat') {
      await page.locator('#btnPlayCreate').click();
      await page.getByRole('menuitem', { name: '新建 Bot', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click();
    }
    const form = page.getByRole('form', { name: '新建 Bot' });
    await expect(form.getByLabel('显示标题', { exact: true })).toBeVisible();
    await expect(form.getByLabel('描述', { exact: true })).toBeVisible();
    await expect(form.getByRole('group', { name: '脸型', exact: true })).toBeVisible();
    await expect(form.getByRole('group', { name: '颜色', exact: true })).toBeVisible();
    await expect(form.getByRole('radiogroup', { name: '表情图标' })).toHaveCount(0);
    await expect(form.getByTestId('bot-create-avatar-url')).toHaveCount(0);
    await expect(form.getByRole('button', { name: '高级选项', exact: true })).toHaveCount(0);
    const preview = form.getByTestId('bot-face-choice-preview');
    await form.getByTestId('bot-create-name').fill('Face Preview A');
    const generatedA = [await preview.getAttribute('data-bot-shape'), await preview.getAttribute('data-bot-color')];
    await form.getByTestId('bot-create-name').fill('Face Preview B');
    await expect.poll(async () => [await preview.getAttribute('data-bot-shape'), await preview.getAttribute('data-bot-color')]).not.toEqual(generatedA);
    await expect(preview).toHaveAttribute('aria-label', 'Face Preview B 的机器人头像');
    await form.getByRole('button', { name: '心形', exact: true }).click();
    await form.getByRole('button', { name: '蓝', exact: true }).click();
    await expect(form.getByRole('button', { name: '心形', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(form.getByRole('button', { name: '蓝', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(preview).toHaveAttribute('data-bot-shape', 'heart');
    await expect(preview).toHaveAttribute('data-bot-color', 'blue');
  });
  });
}

test('invalid names cannot submit; server failure preserves inputs for retry; cancel preserves chat [AC:bot-face-first-creation#AC-4]', async ({ page, request, originalBot }) => {
  const bots = (await (await request.get('/api/bots')).json()).bots as { name: string }[];
  let posts = 0;
  await page.route('**/api/bots', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    await route.fulfill({ status: 503, json: { error: 'Try again' } });
  });
  // Begin with an existing conversation, independently of suite order and default-Bot startup.
  await page.addInitScript(({ id }) => localStorage.setItem('lab.selectedBot', id), originalBot);
  await page.goto('/#/bot');
  const original = page.locator('#playTitle');
  await expect(original).toHaveText(originalBot.name);
  const originalText = await original.textContent();
  await page.locator('#btnPlayCreate').click();
  await page.getByRole('menuitem', { name: '新建 Bot', exact: true }).click();
  const form = page.getByRole('form', { name: '新建 Bot' });
  const submit = form.getByTestId('bot-create-submit');
  await expect(submit).toBeDisabled();
  await form.getByTestId('bot-create-name').fill(originalBot.name);
  await expect(submit).toBeDisabled();
  await expect(form.getByRole('alert')).toContainText('已经有同名的 Bot');
  await form.getByTestId('bot-create-name').fill('Retry Face Bot');
  await form.getByTestId('bot-create-title').fill('My title');
  await form.getByTestId('bot-create-description').fill('My description');
  await form.getByRole('button', { name: '心形', exact: true }).click();
  await submit.click();
  await expect(form.getByRole('alert')).toContainText('创建失败');
  await expect(form.getByTestId('bot-create-name')).toHaveValue('Retry Face Bot');
  await expect(form.getByTestId('bot-create-title')).toHaveValue('My title');
  await expect(form.getByTestId('bot-create-description')).toHaveValue('My description');
  await expect(form.getByRole('button', { name: '心形', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await submit.click();
  await expect.poll(() => posts).toBe(2);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(original).toHaveText(originalText || '');
  const after = (await (await request.get('/api/bots')).json()).bots as { name: string }[];
  expect(after.map(bot => bot.name)).toEqual(bots.map(bot => bot.name));
  expect(posts).toBe(2);
});
