import { test, expect, type Page } from '@playwright/test';

const condition = '完整目标：检查所有数据，保留原始证据，确认报告可读，然后向用户展示结论。'.repeat(5);
const settings = { maxConcurrent: 2, defaultBudgetUsd: 10, maxAttempts: 8, maxNoProgress: 3, leaseMs: 60000, preferredStrategy: 'auto' };
async function openChat(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  const bots = ['a','b'].map(id=>({ id:`density-${id}`,name:`Density ${id}`,agentId:'general',canonicalSessionId:`density-session-${id}`,hidden:false }));
  const sessions = bots.map(bot=>({ id:bot.canonicalSessionId,title:bot.name,mode:'chat',status:'idle',agentId:'general',metadata:{botId:bot.id,canonicalBotChat:true,usageTotals:{inputTokens:100,outputTokens:10,totalTokens:110,requests:1},usageCostUsd:0.01} }));
  await page.route(url=>url.pathname==='/api/bots',r=>r.fulfill({json:{bots}}));
  await page.route(url=>url.pathname==='/api/sessions',r=>r.fulfill({json:{sessions}}));
  await page.route('**/api/bot-functional-groups',r=>r.fulfill({json:{groups:[]}}));
  await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[]}}));
  await page.route('**/api/bot-work/default',r=>r.fulfill({json:{bot:bots[0]}}));
  for (const [i,bot] of bots.entries()) {
    const session=sessions[i];
    await page.route(url=>url.pathname===`/api/bots/${bot.id}`,r=>r.fulfill({json:{bot}}));
    await page.route(url=>url.pathname===`/api/bots/${bot.id}/open`,r=>r.fulfill({json:{bot,session}}));
    await page.route(url=>url.pathname===`/api/sessions/${session.id}`,r=>r.fulfill({json:{session,messages:Array.from({length:16},(_,n)=>({id:`m-${n}`,sessionId:session.id,seq:n+1,role:n%2?'assistant':'user',parts:[{type:'text',text:`聊天记录 ${n}`}],createdAt:new Date(1700000000000+n).toISOString()}))}}));
    await page.route(url=>url.pathname===`/api/sessions/${session.id}/goal`,r=>r.fulfill({json:{goal:{goalId:'review',source:'bot',status:'pending_review',condition,turnsUsed:1,maxTurns:8}}}));
    await page.route(url=>url.pathname===`/api/bots/${bot.id}/goals`,r=>r.fulfill({json:{goals:[{id:'review',title:'核对完整报告',status:'pending_review',progress:'报告已保存',priority:0,evidence:[],budgetUsd:10,costUsd:0.01}],settings}}));
  }
  await page.goto('/#/bot');
  if(width<=760) await page.getByTestId('mobile-sessions-toggle').click();
  await page.locator('#sessionListMini [data-bot-id="density-a"] .list-item--session').click();
  await expect(page.locator('#playTitle')).toHaveText('Density a');
  await expect(page.locator('.goal-status-card')).toBeVisible();
  await expect(page.getByTestId('bot-goal-attention')).toBeVisible();
}

test('mobile collapsed chrome leaves the feed usable [AC:mobile-chat-density#AC-1]',async({page})=>{
 await openChat(page,390);
 await expect(page.getByTestId('mobile-bot-bar-toggle')).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.chat-panel-header__details')).toBeHidden();
 await expect(page.locator('.goal-status-card__body')).toBeHidden();
 const header=await page.locator('.chat-panel-header:visible').boundingBox();
 const card=await page.locator('.goal-status-card').boundingBox();
 const feed=await page.locator('.chat-feed-shell:visible').boundingBox();
 expect(header!.height).toBeLessThan(65);expect(card!.height).toBeLessThan(50);
 expect(feed!.height).toBeGreaterThan(250);
 await expect(page.locator('#playInput')).toBeInViewport({ratio:1});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.screenshot({path:test.info().outputPath('mobile-collapsed.png')});
 for(const width of [360,760]){
  await page.setViewportSize({width,height:844});
  await expect(page.getByTestId('mobile-bot-bar-toggle')).toBeVisible();
  await expect(page.locator('#playInput')).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 }
});
test('mobile chrome can expand and expose complete content and actions [AC:mobile-chat-density#AC-2]',async({page})=>{
 await openChat(page,390);
 await page.getByTestId('mobile-bot-bar-toggle').click();
 await expect(page.getByTestId('chat-header-permissions')).toBeVisible();
 await expect(page.getByTestId('bot-detail-toggle')).toBeVisible();
 await expect(page.locator('#playMeta')).toBeVisible();
 await expect(page.locator('.chat-panel-header__actions')).toBeVisible();
 await page.getByTestId('mobile-goal-card-toggle').click();
 const body=page.locator('.goal-status-card__cond');await expect(body).toBeVisible();await expect(body).toHaveText(condition);
 expect(await body.evaluate(el=>el.scrollHeight<=el.clientHeight+1 && el.scrollWidth<=el.clientWidth+1)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.screenshot({path:test.info().outputPath('mobile-expanded.png')});
 await page.getByTestId('mobile-goal-card-toggle').click();await expect(body).toBeHidden();
 await page.getByTestId('mobile-bot-bar-toggle').click();await expect(page.locator('#playMeta')).toBeHidden();
});
test('mobile goals can be opened from a collapsed native summary [AC:mobile-chat-density#AC-3]',async({page})=>{
 await openChat(page,390);const panel=page.getByTestId('bot-goal-attention');
 await expect(panel).not.toHaveAttribute('open','');
 const summary=panel.locator(':scope > summary');await expect(summary).toBeVisible();
 await summary.click();await expect(panel.getByTestId('bot-goal-review')).toBeVisible();
 await summary.focus();await page.keyboard.press('Enter');await expect(panel.locator('.bot-goals__body')).toBeHidden();
});
test('desktop preserves existing cards and attention panel after viewport changes [AC:mobile-chat-density#AC-4]',async({page})=>{
 await openChat(page,1280);
 await expect(page.getByTestId('mobile-bot-bar-toggle')).toBeHidden();
 await expect(page.getByTestId('mobile-goal-card-toggle')).toBeHidden();
 await expect(page.locator('#playMeta')).toBeVisible();
 await expect(page.locator('.goal-status-card__body')).toBeVisible();
 const panel=page.getByTestId('bot-goal-attention');await expect(panel.locator('.bot-goals__body')).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(panel.locator('.bot-goals__body')).toBeHidden();
 await page.setViewportSize({width:761,height:844});await expect(panel.locator('.bot-goals__body')).toBeVisible();
 await expect(page.getByTestId('mobile-bot-bar-toggle')).toBeHidden();
 await page.setViewportSize({width:1280,height:844});
 await page.screenshot({path:test.info().outputPath('desktop.png')});
});
