import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function revisit(page: Page, request: APIRequestContext, mobile: boolean) {
  test.setTimeout(120000);
  const title = 'Sidechat ' + Date.now();
  const { session } = await (
    await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } })
  ).json();
  const { bot } = await (await request.post('/api/bots', { data: { name: title + ' Bot' } })).json();
  const older = (await (await request.post('/api/bots/' + bot.id + '/open')).json()).session;
  const text = '前一段谈到缓存。再看 KV cache：如何复用缓存？';
  for (const item of [older, session]) {
    const response = await request.post('/api/sessions/' + item.id + '/messages', { data: { message: text } });
    expect(response.ok()).toBeTruthy();
  }
  const catalog = async (id: string) => (await (await request.get('/api/sessions/' + id)).json()).messages;
  const olderMessages = await catalog(older.id);
  const source = olderMessages.filter((m: { role: string }) => m.role === 'assistant').at(-1);
  const reply = source.parts
    .filter((p: { type: string }) => p.type === 'text')
    .map((p: { text: string }) => p.text)
    .join('');
  const quote = reply.includes('KV cache') ? 'KV cache' : reply.trim().slice(0, 3);
  expect(quote.length).toBeGreaterThan(0);
  const seed = await request.post('/api/sidechats', {
    data: {
      sessionId: older.id,
      messageId: source.id,
      anchor: {
        kind: 'range',
        quote,
        start: reply.indexOf(quote),
        end: reply.indexOf(quote) + quote.length,
        prefix: '',
        suffix: ''
      },
      requestId: crypto.randomUUID(),
      question: '上一次学习时的问题'
    }
  });
  expect(seed.ok()).toBeTruthy();
  // Put the annotated reply outside the initial forty-message window.
  for (let i = 0; i < 42; i++) {
    const add = await request.post('/api/sessions/' + older.id + '/messages', {
      data: { message: '后来的笔记 ' + i, autoRun: false }
    });
    expect(add.ok()).toBeTruthy();
  }
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/chat');
  if (mobile) await page.getByTestId('mobile-sessions-toggle').click();
  await page.locator('#sessionListMini .list-item--session').filter({ hasText: title }).first().click();
  const prose = page.locator('[data-sidechat-message] .chat-bubble__body').last();
  await expect(prose).toContainText(quote);
  await page.locator('#playInput').fill('我的主对话草稿');
  await prose.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode,
        at = node.textContent!.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      break;
    }
  }, quote);
  await page.getByTestId('sidechat-selection').click();
  const rail = page.getByTestId('sidechat-dock');
  const question = rail.locator('textarea');
  await question.fill('本次阅读的问题');
  await question.press('Enter');
  await expect(rail).toContainText('本次阅读的问题');
  await expect(page.locator('[data-sidechat-ids]').first()).toBeVisible();
  await question.fill('未发送的侧聊草稿');
  const position = await page.locator('#playMessages').evaluate((feed) => feed.scrollTop);
  await rail.getByRole('button', { name: /相同摘录/ }).click();
  await rail
    .getByRole('button', { name: /上一次学习时的问题/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/chat/);
  await rail.getByRole('button', { name: /打开来源/ }).click();
  await expect(page).toHaveURL(/#\/bot/);
  await expect(page.locator('#playMessages [data-sidechat-ids]').first()).toBeInViewport();
  await page.getByTestId('sidechat-return').click();
  await expect(page).toHaveURL(/#\/chat/);
  await expect(page.locator('#playInput')).toHaveValue('我的主对话草稿');
  if (mobile) await page.locator('[data-sidechat-ids]').first().click();
  await expect(rail).toContainText('本次阅读的问题');
  await expect(question).toHaveValue('未发送的侧聊草稿');
  await expect
    .poll(async () =>
      Math.abs((await page.locator('#playMessages').evaluate((feed) => feed.scrollTop)) - position)
    )
    .toBeLessThan(5);
}
test('同摘录从普通对话预览 Bot 批注并回到原阅读位置 [AC:sidechat#AC-1] [AC:sidechat#AC-4] [AC:sidechat#AC-5]', async ({
  page,
  request
}) => {
  await revisit(page, request, false);
});
test('手机打开旧来源后回到原会话，保留两处输入草稿 [AC:sidechat#AC-1] [AC:sidechat#AC-5]', async ({
  page,
  request
}) => {
  await revisit(page, request, true);
});
