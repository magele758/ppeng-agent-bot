import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

async function openAnnotated(page: Page, request: APIRequestContext, message: string) {
  const title = 'Sidechat delete ' + crypto.randomUUID();
  const created = await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } });
  expect(created.ok()).toBeTruthy();
  const { session } = await created.json();
  const sent = await request.post('/api/sessions/' + session.id + '/messages', { data: { message } });
  expect(sent.ok()).toBeTruthy();
  await page.goto('/#/chat');
  await page.locator('#sessionListMini .list-item--session').filter({ hasText: title }).click();
  const prose = page.locator('[data-sidechat-message] .chat-bubble__body').last();
  await expect(prose).toContainText('甲摘录');
  return { sessionId: session.id as string, prose };
}

async function annotate(page: Page, prose: Locator, quote: string, question: string) {
  await prose.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = getSelection();
      if (!selection) throw new Error('no selection');
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error('missing ' + needle);
  }, quote);
  await page.getByTestId('sidechat-selection').click();
  await page.getByTestId('sidechat-input').fill(question);
  await page.getByTestId('sidechat-send').click();
  await expect(page.getByTestId('sidechat-panel')).toContainText(question);
}

async function confirmDelete(page: Page, accept: boolean) {
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('删除这条侧聊批注');
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.getByTestId('sidechat-delete').click();
}

async function savedTitles(request: APIRequestContext, sessionId: string) {
  const listed = await (await request.get('/api/sidechats?sessionId=' + encodeURIComponent(sessionId))).json();
  return listed.items.map((item: { thread: { title: string } }) => item.thread.title);
}

test('确认删除一条批注后，原文标记和侧栏只保留另一条，主对话还在 [AC:sidechat-delete#AC-1]', async ({
  page,
  request
}) => {
  const message = '请分别说明甲摘录和乙摘录。';
  const { sessionId, prose } = await openAnnotated(page, request, message);
  await annotate(page, prose, '甲摘录', '留下的讨论');
  await page.getByTestId('sidechat-close').click();
  await annotate(page, prose, '乙摘录', '删掉的讨论');
  await confirmDelete(page, true);
  await expect(prose.locator('[data-sidechat-ids]', { hasText: '乙摘录' })).toHaveCount(0);
  await expect(prose.locator('[data-sidechat-ids]', { hasText: '甲摘录' })).toBeVisible();
  const panel = page.getByTestId('sidechat-panel');
  await expect(panel).toContainText('留下的讨论');
  await expect(panel).not.toContainText('删掉的讨论');
  await expect(page.locator('#playMessages')).toContainText(message);
  expect(await savedTitles(request, sessionId)).toEqual(['留下的讨论']);
});

test('取消删除或删除失败时，批注和原文标记都还在 [AC:sidechat-delete#AC-4]', async ({ page, request }) => {
  const message = '请说明甲摘录。';
  const { sessionId, prose } = await openAnnotated(page, request, message);
  await annotate(page, prose, '甲摘录', '还在的讨论');
  await confirmDelete(page, false);
  await expect(page.getByTestId('sidechat-delete')).toBeVisible();
  await expect(prose.locator('[data-sidechat-ids]')).toBeVisible();
  await page.route('**/api/sidechats/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"unavailable"}' });
      return;
    }
    await route.continue();
  });
  await confirmDelete(page, true);
  await expect(page.getByTestId('sidechat-panel').getByRole('alert')).toContainText('没能删除');
  await expect(prose.locator('[data-sidechat-ids]')).toBeVisible();
  await expect(page.getByTestId('sidechat-panel')).toContainText('还在的讨论');
  expect(await savedTitles(request, sessionId)).toEqual(['还在的讨论']);
});
