import { test, expect } from './helpers/bot-pair';

test('switching Bots and reloading restores each saved recommendation without touching drafts [AC:bot-input-suggestion-cache#AC-2]', async ({ page, botPair }) => {
  const bots = botPair.slice(0, 2);
  const reads = new Map<string, number>();
  for (const [index, bot] of bots.entries()) {
    const id = bot.canonicalSessionId;
    await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), route => route.fulfill({ json: {
      session: { id, agentId: bot.id, mode: 'chat', status: 'idle', metadata: { canonicalBotChat: true } },
      messages: [{ id: `reply-${index}`, seq: 2, role: 'assistant', parts: [{ type: 'text', text: '已完成本轮回复' }] }],
      hasMore: false, nextCursor: null
    } }));
    await page.route(`**/api/sessions/${id}/input-suggestion`, route => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return route.fulfill({ json: { enabled: true, suggestion: { primary: `保存的推荐 ${index}`, alternatives: [] } } });
    });
  }
  await page.goto('/#/bot');
  const select = async (index: number) => {
    await page.locator(`#sessionListMini [data-bot-id="${bots[index].id}"] .list-item--session`).click();
    await expect(page.locator('#playTitle')).toHaveText(bots[index].name);
  };
  const input = page.locator('#playInput');
  await select(0);
  await expect.poll(() => reads.get(bots[0].canonicalSessionId) ?? 0).toBeGreaterThan(0);
  await input.focus();
  await expect(page.locator('#playInputSuggestion')).toContainText('保存的推荐 0');
  await select(1);
  await input.focus();
  await expect(page.locator('#playInputSuggestion')).toContainText('保存的推荐 1');
  const before = reads.get(bots[0].canonicalSessionId) ?? 0;
  await select(0);
  // Restoration begins on selection, without requiring a new focus event.
  await expect.poll(() => reads.get(bots[0].canonicalSessionId) ?? 0).toBeGreaterThan(before);
  await input.focus();
  await expect(page.locator('#playInputSuggestion')).toContainText('保存的推荐 0');
  await page.reload();
  await input.focus();
  await expect(page.locator('#playInputSuggestion')).toContainText('保存的推荐 0');
  await input.fill('我自己写的草稿');
  await expect(page.locator('#playInputSuggestion')).toHaveCount(0);
  await input.blur(); await input.focus();
  await expect(input).toHaveValue('我自己写的草稿');
  await expect(page.locator('#playInputSuggestion')).toHaveCount(0);
});
