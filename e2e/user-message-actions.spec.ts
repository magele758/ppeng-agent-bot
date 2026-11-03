import { test, expect } from '@playwright/test';

async function openFixture(page, request) {
  const created = await request.post('/api/bots', { data: { name: `Message actions ${Date.now()}` } });
  expect(created.status()).toBe(201);
  const { bot } = await created.json();
  const opened = await request.post(`/api/bots/${bot.id}/open`);
  const { session } = await opened.json();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { message: 'Please retry this original message', autoRun: false } });
  await page.goto('/#/agents/bots');
  await page.getByRole('searchbox', { name: '搜索 Bot' }).fill(bot.name);
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话', exact: true }).click();
  const row = page.locator('#playMessages .chat-turn--user').filter({ hasText: 'Please retry this original message' }).first();
  await expect(row).toBeVisible();
  return { row, session };
}

test('own message hover keyboard copy and copy failure [AC:user-message-actions#AC-1] [AC:user-message-actions#AC-2]', async ({ page, request }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { (window as any).copiedText = text; } } }));
  const { row } = await openFixture(page, request);
  await page.mouse.move(0, 0);
  await expect(row.locator('details.user-message-actions')).toHaveCSS('opacity', '0');
  await row.hover();
  await row.locator('summary').focus();
  await page.keyboard.press('Enter');
  await row.getByRole('button', { name: '复制', exact: true }).click();
  await expect(row.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => (window as any).copiedText)).toBe('Please retry this original message');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
  await row.getByRole('button', { name: '复制', exact: true }).click();
  await expect(row.getByRole('status')).toHaveText('复制失败，请重试');
  await row.locator('summary').focus();
  await page.keyboard.press('Escape');
  await expect(row.locator('details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.chat-turn--assistant .user-message-actions')).toHaveCount(0);
  await row.locator('summary').click();
  await page.screenshot({ path: 'test-results/user-message-actions.png' });
});

test('retry sends the selected message once and preserves draft across failure [AC:user-message-actions#AC-3] [AC:user-message-actions#AC-4]', async ({ page, request }) => {
  const { row, session } = await openFixture(page, request);
  await page.getByLabel('消息内容').fill('keep my unfinished draft');
  let posts = 0;
  let release!: () => void;
  await page.route(`**/api/sessions/${session.id}/stream`, async route => {
    posts++;
    expect(route.request().postDataJSON().message).toBe('Please retry this original message');
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { error: 'offline' } });
  });
  await row.hover();
  await row.locator('summary').click();
  await row.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  try { await expect(row.getByRole('button', { name: '重试', exact: true })).toBeDisabled(); }
  finally { release(); }
  await expect(row.getByRole('status')).toHaveText('重试失败，请稍后再试');
  await expect(page.getByLabel('消息内容')).toHaveValue('keep my unfinished draft');
  expect(posts).toBe(1);
  await page.unroute(`**/api/sessions/${session.id}/stream`);
  await row.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('#playMessages .chat-turn--assistant')).toContainText(['你好，我现在已经是一个基于工具循环'], { timeout: 60000 });
  await expect(page.getByLabel('消息内容')).toHaveValue('keep my unfinished draft');
});

 test.describe('touch message actions', () => {
   test.use({ hasTouch: true });
   test('touch can open actions without hover [AC:user-message-actions#AC-1]', async ({ page, request }) => {
     const { row } = await openFixture(page, request);
     expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
     await expect(row.locator('details.user-message-actions')).toHaveCSS('opacity', '1');
     await row.locator('summary').tap();
     await expect(row.getByRole('button', { name: '复制', exact: true })).toBeVisible();
     await expect(row.getByRole('button', { name: '重试', exact: true })).toBeVisible();
   });
 });
