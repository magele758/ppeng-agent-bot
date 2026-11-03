import { test, expect } from '@playwright/test';

test('Bot name labels stored and generating replies [AC:bot-message-name#AC-1]', async ({ page, request }) => {
  const name = `Named Bot ${Date.now()}`;
  const created = await request.post('/api/bots', { data: { name } });
  expect(created.status()).toBe(201);
  const { bot } = await created.json();
  const opened = await request.post(`/api/bots/${bot.id}/open`);
  const { session } = await opened.json();
  const sent = await request.post(`/api/sessions/${session.id}/messages`, { data: { message: 'hello' } });
  expect(sent.ok()).toBe(true);
  await page.goto('/#/agents/bots');
  await page.getByRole('searchbox', { name: '搜索 Bot' }).fill(name);
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(page.locator('#playMessages .chat-turn--assistant .chat-turn__label').first()).toHaveText(name);
  await expect(page.locator('#playMessages .chat-turn--user .chat-turn__label').first()).toHaveText('你');
  let release!: () => void;
  await page.route(`**/api/sessions/${session.id}/stream`, async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { error: 'test complete' } });
  });
  await page.getByLabel('消息内容').fill('next question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  try {
    await expect(page.locator('#playMessages .chat-turn--streaming .chat-turn__label')).toHaveText(`${name}（生成中）`);
    await page.screenshot({ path: 'test-results/bot-message-name.png' });
  } finally { release?.(); }
});
