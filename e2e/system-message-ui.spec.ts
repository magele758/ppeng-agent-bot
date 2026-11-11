import { test, expect } from './helpers/bot-pair';

// Inspect individual notice cards in full transcript; brief grouping has its own coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lab.sessionBrief', '0'));
});

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

test('background receipts are system cards, including legacy user rows [AC:background-job-notice#AC-2]',async({page,botPair},testInfo)=>{
  const bot=botPair[0],id=bot.canonicalSessionId;
  const text='Background job bg_legacy completed.\n(no output)';
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`),route=>route.fulfill({json:{
    session:{id,agentId:bot.id,mode:'chat',status:'idle',metadata:{canonicalBotChat:true}},
    messages:[
      {id:'legacy',seq:1,role:'user',key:'background-job:bg_legacy',parts:[{type:'text',text}]},
      {id:'current',seq:2,role:'system',key:'source:event:background-job:bg_current',parts:[{type:'text',text:'[background-job] bg_current completed; finished_at=2026-11-11T02:39:28Z\n(no output)'}]},
      {id:'human',seq:3,role:'user',parts:[{type:'text',text}]}
    ],hasMore:false,nextCursor:null
  }}));
  await page.goto('/#/bot');
  await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
  const cards=page.getByTestId('system-notice-card');
  await expect(cards).toHaveCount(2);
  for(const card of await cards.all())await expect(card).toContainText('后台任务状态');
  await expect(page.locator('.chat-turn--user')).toHaveCount(1);
  await expect(page.locator('.chat-turn--user')).toContainText(text);
  await page.screenshot({path:testInfo.outputPath('background-receipts.png'),fullPage:true});
});

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
