import { test, expect } from './helpers/bot-pair';

const info = '[risk-advisory]\nRisk signals detected:\n- iteration_near_limit (magnitude=2)\nChange strategy: try a different tool, smaller steps, or ask the user. Avoid repeating the failing pattern.';
const warning = '[risk-advisory]\nRisk signals detected:\n- tool_error_streak (magnitude=3)';

test('risk cards distinguish system notices, preserve details and fit mobile in both languages [AC:risk-advisory-ui#AC-1] [AC:risk-advisory-ui#AC-2] [AC:risk-advisory-ui#AC-3]', async ({ page, botPair }) => {
  const bot = botPair[0];
  const id = bot.canonicalSessionId;
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), route => route.fulfill({ json: {
    session: { id, agentId: bot.id, mode: 'chat', status: 'idle', metadata: { canonicalBotChat: true } },
    messages: [
      { id: 'info', role: 'system', seq: 1, parts: [{ type: 'text', text: info }] },
      { id: 'user', role: 'user', seq: 2, parts: [{ type: 'text', text: info }] },
      { id: 'warning', role: 'system', seq: 3, parts: [{ type: 'text', text: warning }] },
      { id: 'unknown', role: 'system', seq: 4, parts: [{ type: 'text', text: '[risk-advisory]\n- future_signal (magnitude=1)\n'+'x'.repeat(300) }] }
    ], hasMore: false, nextCursor: null
  } }));
  await page.goto('/#/bot');
  await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
  const cards = page.getByTestId('risk-advisory');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('本次执行接近迭代上限');
  await expect(cards.nth(1)).toContainText('执行异常提醒');
  await expect(cards.nth(0).locator('pre')).toBeHidden();
  await cards.nth(0).locator('summary').click();
  await expect(cards.nth(0).locator('pre')).toHaveText(info);
  await expect(page.locator('.chat-turn--user')).toContainText('[risk-advisory]');
  await expect(page.locator('.chat-turn--user').getByTestId('risk-advisory')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await cards.nth(2).locator('summary').click();
  const bounds = await cards.nth(2).evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  await page.evaluate(() => localStorage.setItem('lab.locale', 'en'));
  await page.reload();
  await expect(cards.nth(0)).toContainText('Run advisory');
  await expect(cards.nth(1)).toContainText('Execution warning');
  await expect(cards.nth(0)).not.toContainText(/[\u3400-\u9fff]/);
});
