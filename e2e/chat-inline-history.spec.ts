import { test, expect, type Page } from '@playwright/test';
const condition = '完整目标：检查所有数据，保留原始证据，确认报告可读，然后向用户展示结论。'.repeat(5);
const settings = { maxConcurrent: 2, defaultBudgetUsd: 10, maxAttempts: 8, maxNoProgress: 3, leaseMs: 60000, preferredStrategy: 'auto' };
async function openChat(page: Page, width: number, history?: (route: import("@playwright/test").Route) => Promise<void>) {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  const bots = ['a','b'].map(id=>({ id:`density-${id}`,name:`Density ${id}`,agentId:'general',canonicalSessionId:`density-session-${id}`,hidden:false }));
  const sessions = bots.map(bot=>({ id:bot.canonicalSessionId,title:bot.name,mode:'chat',status:'idle',agentId:'general',metadata:{botId:bot.id,canonicalBotChat:true,usageTotals:{inputTokens:100,outputTokens:10,totalTokens:110,requests:1},usageCostUsd:0.01} }));
  await page.route(url=>url.pathname==='/api/bots',r=>r.fulfill({json:{bots}}));
  await page.route(url=>url.pathname==='/api/sessions',r=>r.fulfill({json:{sessions}}));
  await page.route('**/api/bot-functional-groups',r=>r.fulfill({json:{groups:[]}}));
  await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[]}}));
  await page.route('**/api/bot-work/default',r=>r.fulfill({json:{bot:bots[1]}}));
  for (const [i,bot] of bots.entries()) {
    const session=sessions[i];
    await page.route(url=>url.pathname===`/api/bots/${bot.id}`,r=>r.fulfill({json:{bot}}));
    await page.route(url=>url.pathname===`/api/bots/${bot.id}/open`,r=>r.fulfill({json:{bot,session}}));
    await page.route(url=>url.pathname===`/api/sessions/${session.id}`,((i === 0 ? history : undefined) ?? (r=>r.fulfill({json:{session,messages:Array.from({length:16},(_,n)=>({id:`m-${n}`,sessionId:session.id,seq:n+1,role:n%2?'assistant':'user',parts:[{type:'text',text:`聊天记录 ${n}`}],createdAt:new Date(1700000000000+n).toISOString()}))}}))));
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


test('attachment stays inline at mobile and desktop sizes [AC:chat-inline-history#AC-1]', async ({ page }) => {
  await openChat(page, 390);
  for (const width of [360, 390, 760, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const attach = page.locator('[aria-controls="composerAttachPanel"]');
    const input = page.locator('#playInput');
    const a = (await attach.boundingBox())!;
    const b = (await input.boundingBox())!;
    const send = (await page.locator('#btnSend').boundingBox())!;
    expect(Math.min(a.y+a.height,b.y+b.height,send.y+send.height)-Math.max(a.y,b.y,send.y)).toBeGreaterThan(0);
    await expect(page.locator('.chat-composer').locator('[aria-controls="composerAttachPanel"]')).toHaveCount(1);
    await attach.click();
    await expect(page.locator('#composerAttachPanel')).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#composerAttachPanel button').first().click();
    await chooser;
    await attach.click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

function historyFixture(fail = false, shortTail = false) {
  const requests: number[] = [];
  let failed = false;
  const handler = async (route: import('@playwright/test').Route) => {
    const before = Number(new URL(route.request().url()).searchParams.get('beforeSeq') || 151);
    if (before < 151) {
      requests.push(before);
      await new Promise(resolve => setTimeout(resolve, 250));
      if (fail && !failed) { failed = true; await route.fulfill({status:503,json:{error:'history unavailable'}}); return; }
    }
    const start = shortTail && before === 151 ? 149 : Math.max(1,before-50);
    await route.fulfill({json:{session:{id:'density-session-a',status:'idle',agentId:'general',metadata:{botId:'density-a',canonicalBotChat:true}},messages:Array.from({length:before-start},(_,i)=>({id:`history-${start+i}`,seq:start+i,role:'user',parts:[{type:'text',text:`History row ${start+i}`}],createdAt:new Date(1700000000000+start+i).toISOString()})),hasMore:start>1,nextCursor:start>1?start:null}});
  };
  return {requests,handler};
}

async function top(page: Page) {
  await page.locator('#playMessages').evaluate(el => { el.scrollTop = 0; });
}

test('scroll prepends history without a button or jumping [AC:chat-inline-history#AC-2]', async ({page}) => {
  const fixture = historyFixture();
  await openChat(page,390,fixture.handler);
  await expect(page.getByTestId('feed-load-older')).toHaveCount(0);
  const feed = page.locator('#playMessages');
  await top(page);
  await expect.poll(()=>fixture.requests.length).toBe(1);
  await expect.poll(()=>feed.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  await expect(feed.getByText('History row 101',{exact:true})).toBeInViewport();
  await top(page);
  await expect.poll(()=>fixture.requests.length).toBe(2);
  await expect.poll(()=>feed.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  await top(page);
  await expect(feed.getByText('History row 1',{exact:true})).toBeVisible();
  await page.waitForTimeout(600);
  expect(fixture.requests).toEqual([101,51]);
});

test('failed history offers retry without an automatic request loop [AC:chat-inline-history#AC-3]', async ({page}) => {
  const fixture = historyFixture(true);
  await openChat(page,390,fixture.handler);
  // The first page has to be on screen before scrolling. Scrolling an empty feed
  // leaves the reader stuck to the bottom, so the failed older page never starts.
  await expect(page.locator('#playMessages').getByText('History row 150', { exact: true })).toBeVisible();
  await top(page);
  const retry = page.getByTestId('feed-retry-older');
  await expect(retry).toBeVisible();
  await page.waitForTimeout(600);
  expect(fixture.requests).toEqual([101]);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect.poll(()=>fixture.requests.length).toBe(2);
  await expect.poll(()=>page.locator('#playMessages').evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  expect(fixture.requests).toEqual([101,101]);
});

test('a short tail fills the viewport automatically [AC:chat-inline-history#AC-2]', async ({page}) => {
  const fixture = historyFixture(false, true);
  await openChat(page,390,fixture.handler);
  await expect.poll(()=>fixture.requests.length).toBe(1);
  await expect(page.locator('#playMessages').getByText('History row 150',{exact:true})).toBeInViewport();
  await page.waitForTimeout(600);
  expect(fixture.requests).toEqual([149]);
});

test('a late history failure does not leak into another bot [AC:chat-inline-history#AC-3]', async ({page}) => {
  const fixture = historyFixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await openChat(page,390,async route => {
    if (new URL(route.request().url()).searchParams.has('beforeSeq')) {
      requested = true;
      await pending;
      await route.fulfill({status:503,json:{error:'late failure'}});
    } else await fixture.handler(route);
  });
  await top(page);
  await expect.poll(()=>requested).toBe(true);
  await page.getByTestId('mobile-sessions-toggle').click();
  await page.locator('#sessionListMini [data-bot-id="density-b"] .list-item--session').click();
  await expect(page.locator('#playTitle')).toHaveText('Density b');
  release();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('feed-retry-older')).toHaveCount(0);
  await expect(page.locator('#playMessages')).toContainText('聊天记录');
});
