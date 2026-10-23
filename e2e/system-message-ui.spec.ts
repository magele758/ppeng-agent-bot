import { test, expect } from './helpers/bot-pair';

const samples = [
  '[recovery] Stopped: empty_assistant',
  '[recovery-advisory] Try a smaller step.',
  '[model-fallback] A secondary model was selected.',
  '[goal] not yet met: evidence required',
  '[on-compact] Context has been summarized.',
  '[stop-hook] An extension requested another check.',
  '[bot-help] A helper returned a result.',
  '[command-hardline] A command was blocked.',
  '[explicit-shared-context] Background information.',
  '[future-marker] '+ 'long-original-'.repeat(100),
  'Unmarked extension output\n'+'additional text '.repeat(100)
];

test('all system text has a collapsed, readable fallback and survives mobile and English [AC:system-message-ui#AC-1] [AC:system-message-ui#AC-2] [AC:system-message-ui#AC-4]', async ({ page, botPair }) => {
  const bot=botPair[0], id=bot.canonicalSessionId;
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), route => route.fulfill({ json: {
    session: { id, agentId: bot.id, mode: 'chat', status: 'idle', metadata: { canonicalBotChat: true } },
    messages: samples.map((text,i) => ({ id:`notice-${i}`, role:'system', seq:i+1, parts:[{type:'text',text}] })),
    hasMore:false,nextCursor:null
  } }));
  await page.goto('/#/bot');
  await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
  const cards=page.getByTestId('system-notice-card');
  await expect(cards).toHaveCount(samples.length);
  await expect(cards.nth(0)).toContainText('执行已停止');
  await expect(cards.nth(5)).toContainText('扩展通知');
  await expect(cards.nth(9)).toContainText('系统通知');
  await expect(page.locator('.chat-turn--system .chat-bubble__pre')).toHaveCount(0);
  for (const card of await cards.all()) await expect(card.locator('pre')).toBeHidden();
  await cards.nth(9).locator('summary').click();
  await expect(cards.nth(9).locator('pre')).toHaveText(samples[9]);
  await page.setViewportSize({width:390,height:844});
  for (const card of await cards.all()) {
    const widths=await card.evaluate(el=>[el.clientWidth,el.scrollWidth]);
    expect(widths[1]).toBeLessThanOrEqual(widths[0]+1);
  }
  await page.evaluate(()=>localStorage.setItem('lab.locale','en'));
  await page.reload();
  await expect(cards.nth(0)).toContainText('Execution stopped');
  await expect(cards.nth(9)).toContainText('System notice');
  await expect(cards.nth(9)).not.toContainText(/[\u3400-\u9fff]/);
});
