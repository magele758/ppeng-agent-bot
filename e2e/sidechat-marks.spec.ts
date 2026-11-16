import { test, expect, type Locator } from '@playwright/test';

async function selectSecondOccurrence(prose: Locator, quote: string) {
  return prose.evaluate((root, value) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let prefix = '',
      count = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
        if (++count !== 2) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + value.length);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
        return prefix.length + at;
      }
      prefix += text;
    }
    throw new Error('The fixture must contain the quote twice in the visible assistant reply.');
  }, quote);
}

test('同一回复的第二个重复词可挂两条批注，刷新后用键盘分别打开 [AC:sidechat#AC-1] [AC:sidechat#AC-4]', async ({
  page,
  request
}) => {
  const quote = '缓存';
  const title = 'Sidechat marks ' + crypto.randomUUID();
  const sessionResponse = await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } });
  expect(sessionResponse.ok()).toBeTruthy();
  const { session } = await sessionResponse.json();
  const path = '/api/sessions/' + session.id;
  const send = await request.post(path + '/messages', { data: { message: '先读缓存的定义，再问缓存的容量。' } });
  expect(send.ok()).toBeTruthy();
  const catalog = await (await request.get(path)).json();
  const source = catalog.messages.findLast((m: { role: string }) => m.role === 'assistant');
  const unrelated = '整条回答的另一处批注';
  const seed = await request.post('/api/sidechats', {
    data: {
      sessionId: session.id,
      messageId: source.id,
      anchor: { kind: 'message', quote: '整条回答' },
      question: unrelated,
      requestId: crypto.randomUUID()
    }
  });
  expect(seed.ok()).toBeTruthy();

  await page.goto('/#/chat');
  const sessionButton = page.locator('#sessionListMini .list-item--session').filter({ hasText: title });
  await sessionButton.click();
  const row = page.locator('[data-sidechat-message="' + source.id + '"]');
  const prose = row.locator('.chat-bubble__body.chat-bubble__md').first();
  await expect(prose).toContainText('再问缓存的容量');
  const questions = ['这里的容量怎么计算？', '容量和上下文长度有什么关系？'];
  let offset = 0;
  for (const question of questions) {
    offset = await selectSecondOccurrence(prose, quote);
    await page.getByTestId('sidechat-selection').click();
    await page.getByTestId('sidechat-input').fill(question);
    await page.getByTestId('sidechat-send').click();
    await expect(page.locator('.sc-messages article[data-role="user"]')).toContainText(question);
    await page.getByTestId('sidechat-close').click();
  }
  await page.reload();
  await sessionButton.click();
  const mark = prose.locator('[data-sidechat-ids]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText(quote);
  await expect(mark).toHaveAttribute('tabindex', '0');
  const location = await mark.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.closest('.chat-bubble__body')!);
    range.setEndBefore(el);
    return range.toString();
  });
  expect(location.length).toBe(offset);
  expect(location).toContain('先读缓存的定义，再问');
  const dock = page.getByTestId('sidechat-panel');
  for (const question of questions) {
    await mark.focus();
    await mark.press('Enter');
    const choices = dock.getByTestId('sidechat-thread');
    await expect(choices).toHaveCount(2);
    await expect(choices.filter({ hasText: unrelated })).toHaveCount(0);
    await choices.filter({ hasText: question }).click();
    await expect(dock.locator('.sc-messages article[data-role="user"]')).toHaveText(new RegExp(question));
    await dock.getByTestId('sidechat-close').click();
  }
});
