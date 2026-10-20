import { test, expect } from '@playwright/test';

test('quote survives send and reload through the real chat API [AC:bot-reply-quote#AC-1] [AC:bot-reply-quote#AC-5]', async ({ page, request }) => {
  // Two streaming waits are each allowed 60s, so the test budget has to cover both plus the reload.
  test.setTimeout(180_000);
  const created = await request.post('/api/bots', { data: { name: `Quote ${Date.now()}` } });
  expect(created.status()).toBe(201);
  const { bot } = await created.json();
  async function openBot() {
    await page.goto('/#/agents/bots');
    await page.getByRole('searchbox', { name: '搜索 Bot' }).fill(bot.name);
    await page.getByTestId(`bot-card-${bot.id}`).click();
    await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话', exact: true }).click();
  }
  await openBot();
  await page.getByLabel('消息内容').fill(`quote source ${Date.now()}`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const box = page.locator('#playMessages');
  await expect(box.locator('.chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
  const source = box.getByTestId('reply-quote-start').last();
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.getByTestId('composer-reply-quote')).toBeVisible();
  const content = `quoted question ${Date.now()}`;
  await page.getByLabel('消息内容').fill(content);
  const sent = page.waitForRequest(request => request.method() === 'POST' && /\/api\/(chat\/stream|sessions\/[^/]+\/(messages|stream))/.test(new URL(request.url()).pathname));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await sent).postDataJSON().replyTo.messageId).toBeTruthy();
  await expect(box.locator('.chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
  await expect(box.getByTestId('message-reply-quote').last()).toBeVisible();
  await page.reload();
  await openBot();
  await expect(box).toContainText(content);
  await expect(box.getByTestId('message-reply-quote').last()).toBeVisible();
});
