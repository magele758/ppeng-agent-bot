import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function openAnnotatedReply(page: Page, request: APIRequestContext) {
  const title = 'Sidechat learning ' + crypto.randomUUID();
  const created = await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } });
  expect(created.ok()).toBeTruthy();
  const { session } = await created.json();
  const sent = await request.post('/api/sessions/' + session.id + '/messages', { data: { message: '请解释缓存。' } });
  expect(sent.ok()).toBeTruthy();
  await page.goto('/#/chat');
  await page.locator('#sessionListMini .list-item--session').filter({ hasText: title }).click();
  const prose = page.locator('[data-sidechat-message] .chat-bubble__body').last();
  await expect(prose).toContainText('缓存');
  return { sid: session.id as string, prose };
}

async function selectQuote(prose: ReturnType<Page['locator']>, quote: string) {
  await prose.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent!.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      break;
    }
  }, quote);
}

test('侧聊可以解释、掌握、凝练、引用，并按状态找回 [AC:sidechat-learning#AC-1] [AC:sidechat-learning#AC-2] [AC:sidechat-learning#AC-3] [AC:sidechat-learning#AC-4] [AC:sidechat-learning#AC-5] [AC:sidechat-learning#AC-6]', async ({
  page,
  request
}) => {
  test.setTimeout(180000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const { sid, prose } = await openAnnotatedReply(page, request);
  const turns = () => page.locator('#playMessages .chat-turn').count();
  const before = await turns();
  await selectQuote(prose, '缓存');
  await page.getByTestId('sidechat-copy-selection').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('缓存');
  await selectQuote(prose, '缓存');
  await page.getByTestId('sidechat-explain-selection').click();
  const panel = page.getByTestId('sidechat-panel');
  await expect(panel).toContainText('请结合上下文，用通俗易懂的语言解释');
  await expect(page.getByTestId('sidechat-cite')).toBeVisible();
  expect(await turns()).toBe(before);
  await expect(page.locator('#playInput')).toHaveValue('');

  await page.getByTestId('sidechat-chip-example').click();
  await expect(panel).toContainText('请举一个具体例子来说明');
  await expect(page.getByTestId('sidechat-cite')).toHaveCount(2);
  expect(await turns()).toBe(before);

  await page.getByTestId('sidechat-grasp').click();
  await expect(page.locator('[data-sidechat-ids]').first()).toHaveAttribute('data-sidechat-grasp', 'mastered');
  await expect(page.getByTestId('sidechat-grasp-label-mastered')).toBeVisible();
  await page.getByTestId('sidechat-filter-thinking').click();
  await expect(page.getByTestId('sidechat-thread')).toHaveCount(0);
  await page.getByTestId('sidechat-filter-mastered').click();
  await expect(page.getByTestId('sidechat-thread')).toHaveCount(1);
  await page.getByTestId('sidechat-sort').click();
  await expect(page.getByTestId('sidechat-sort')).toHaveText('按原文顺序');

  await page.getByTestId('sidechat-distill').click();
  await expect(page.getByTestId('sidechat-note')).toContainText('凝练成一句话');
  await expect(page.locator('[data-sidechat-ids]').first()).toHaveAttribute('title', /凝练成一句话/);
  await page.getByTestId('sidechat-note-clear').click();
  await expect(page.getByTestId('sidechat-note')).toHaveCount(0);
  await page.route('**/api/sidechats/*/note', (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'sidechat_note_needs_reply' }) })
  );
  await page.getByTestId('sidechat-distill').click();
  await expect(panel.getByRole('alert')).toContainText('先完成一轮回答');
  await page.unroute('**/api/sidechats/*/note');
  await page.getByTestId('sidechat-note-edit').click();
  await page.getByTestId('sidechat-note-input').fill('手写金句xyz');
  await page.getByTestId('sidechat-note-save').click();
  await expect(page.getByTestId('sidechat-note')).toHaveText('手写金句xyz');
  await page.route('**/api/sidechats/*/note', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'failed' }) })
  );
  await page.getByTestId('sidechat-distill').click();
  await expect(panel.getByRole('alert')).toContainText('没能凝练');
  await expect(page.getByTestId('sidechat-note')).toHaveText('手写金句xyz');
  await page.unroute('**/api/sidechats/*/note');

  await page.locator('#playInput').fill('已有草稿');
  await page.getByTestId('sidechat-copy-reply').last().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('例子');
  await page.getByTestId('sidechat-cite').last().click();
  await expect(page.locator('#playInput')).toHaveValue(/已有草稿[\s\S]*参考结论/);
  expect(await turns()).toBe(before);

  page.once('dialog', (dialog) => dialog.accept('新的旁注标题'));
  await page.getByTestId('sidechat-rename').click();
  await expect(page.getByTestId('sidechat-thread')).toContainText('新的旁注标题');
  await page.getByTestId('sidechat-all').click();
  await page.getByTestId('sidechat-search').locator('summary').click();
  await page.getByLabel('掌握状态').selectOption('mastered');
  await expect(page.getByTestId('sidechat-search')).toContainText('新的旁注标题');
  await page.getByLabel('搜索摘录、问题或回答').fill('手写金句xyz');
  await expect(page.getByTestId('sidechat-search')).toContainText('手写金句xyz');
  const visible = await (await request.get('/api/sidechats?sessionId=' + encodeURIComponent(sid))).json();
  expect(visible.items).toHaveLength(1);

  await selectQuote(prose, '缓存');
  await page.getByTestId('sidechat-open-existing').click();
  await expect(panel).toContainText('请结合上下文，用通俗易懂的语言解释');
  expect((await (await request.get('/api/sidechats?sessionId=' + encodeURIComponent(sid))).json()).items).toHaveLength(1);
});
