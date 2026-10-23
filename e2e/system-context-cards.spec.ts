import { test, expect } from './helpers/bot-pair';

const summary = 'Goal\n- **Publish the demo**\n\nConstraints\n- Keep local settings private\n\nProgress\n- Tests pass\n\nDecisions\n- Use the existing renderer\n\nFiles\n- `demo.ts`\n\nNext steps\n1. Review the change\n\nHistory source: retained original messages 1-10.';
const jev = '[jev-route] jev-route need_tools noul 0.77. Continue working.';

test('summary and Jev cards are readable, collapsible, localized and mobile safe [AC:system-context-cards#AC-1] [AC:system-context-cards#AC-2] [AC:system-context-cards#AC-3] [AC:system-context-cards#AC-4]', async ({ page, botPair }) => {
  const bot = botPair[0], id = bot.canonicalSessionId;
  const texts = [summary, jev, '[jev-route] Achieved: jev-route done noul 0.90', '[jev-route] unfamiliar detail '+ 'x'.repeat(400)];
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), route => route.fulfill({ json: {
    session: { id, agentId: bot.id, mode: 'chat', status: 'idle', metadata: { canonicalBotChat: true } },
    messages: [
      ...texts.map((text, i) => ({ id: `system-${i}`, role: 'system', seq: i+1, parts: [{ type: 'text', text }] })),
      { id: 'user-quote', role: 'user', seq: 5, parts: [{ type: 'text', text: summary+'\n'+jev }] }
    ], hasMore: false, nextCursor: null
  } }));
  await page.goto('/#/bot');
  await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
  const card = page.getByTestId('system-summary-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('不代表当前目标的实时状态');
  for (const section of await card.locator('section').all()) await expect(section).toBeHidden();
  await card.getByText('展开摘要', { exact: true }).click();
  await expect(card.getByRole('heading', { name: '约束', exact: true })).toBeVisible();
  await expect(card.locator('section strong')).toHaveText('Publish the demo');
  await card.getByText('原始详情', { exact: true }).click();
  await expect(card.locator('pre')).toHaveText(summary);
  const jevCards = page.getByTestId('system-jev-card');
  await expect(jevCards).toHaveCount(3);
  await expect(jevCards.nth(0)).toContainText('建议继续调用工具');
  await expect(jevCards.nth(0)).toContainText('0.77');
  await expect(jevCards.nth(1)).toContainText('不等于目标已完成');
  await expect(jevCards.nth(0).locator('pre')).toBeHidden();
  await expect(page.locator('.chat-turn--user').locator('[data-testid$="-card"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await jevCards.nth(2).locator('summary').click();
  await expect(jevCards.nth(2).locator('pre')).toHaveText(texts[3]);
  for (const target of [card, jevCards.nth(2)]) {
    const widths = await target.evaluate(el => [el.clientWidth, el.scrollWidth]);
    expect(widths[1]).toBeLessThanOrEqual(widths[0] + 1);
  }
  await page.evaluate(() => localStorage.setItem('lab.locale', 'en'));
  await page.reload();
  await expect(card).toContainText('Conversation summary');
  await expect(jevCards.nth(0)).toContainText('Continue using tools');
  await expect(card).not.toContainText(/[\u3400-\u9fff]/);
});
