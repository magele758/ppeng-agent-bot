import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 1218, height: 1104 }, reducedMotion: 'reduce' });
const sid = 'polish-session';
const bot = { id: 'polish-bot', name: 'Polish Bot', agentId: 'general', canonicalSessionId: sid };
const session = { id: sid, title: bot.name, mode: 'chat', status: 'idle', agentId: 'general', metadata: { botId: bot.id, canonicalBotChat: true } };
const message = (id: string, text: string, role = 'assistant', key?: string) => ({ id, seq: Number(id.replace(/\D/g, '')) || 1, role, parts: [{ type: 'text', text }], ...(key ? { key } : {}) });
async function setup(page: Page, messages = [message('m1', '这是一条可引用的回复。\n'.repeat(12))]) {
  await page.addInitScript(() => { localStorage.setItem('lab.locale', 'zh'); localStorage.setItem('theme', 'light'); });
  await page.route('**/api/bots', r => r.fulfill({ json: { bots: [bot] } }));
  await page.route('**/api/bots/polish-bot/open', r => r.fulfill({ json: { bot, session } }));
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [] } }));
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [] } }));
  await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [session] } }));
  await page.route(/\/api\/sessions\/polish-session(?:\?|$)/, r => r.fulfill({ json: { session, messages, latestAssistant: '' } }));
  await page.route('**/api/sessions/polish-session/goal', r => r.fulfill({ json: { goal: null } }));
  await page.goto('/#/bot');
  await page.locator('.session-item__title', { hasText: bot.name }).click();
  await expect(page.locator('#playInput')).toBeVisible();
}

test('compact quote previews preserve drafts and send the selected reply [AC:bot-workspace-interaction-polish#AC-1] [AC:bot-workspace-interaction-polish#AC-2]', async ({ page }) => {
  await setup(page);
  await page.locator('#playInput').fill('我的草稿');
  const start = page.getByTestId('reply-quote-start').first();
  await expect(start.locator('svg')).toHaveCount(1);
  await start.click();
  const quote = page.getByTestId('composer-reply-quote');
  await expect(quote).toContainText('Polish Bot');
  await page.screenshot({ path: '/tmp/bot-polish-review.png' });
  expect(await quote.locator('.composer-reply-quote__excerpt').evaluate(el => el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) * 3 + 1)).toBe(true);
  await page.getByTestId('composer-reply-quote-cancel').click();
  await expect(page.locator('#playInput')).toHaveValue('我的草稿');
  await start.click();
  let payload: any;
  await page.route('**/api/sessions/polish-session/stream', r => { payload = r.request().postDataJSON(); return r.fulfill({ status: 503, json: { error: 'fixture' } }); });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => payload?.replyTo?.messageId).toBe('m1');
});

test('routine cards and long history are readable without hiding ordinary lookalikes [AC:bot-workspace-interaction-polish#AC-3] [AC:bot-workspace-interaction-polish#AC-16]', async ({ page }) => {
  await setup(page, [message('m1', '[routine:提醒] completed\nHello\nRun: routine_run_abc · /api/sessions/child', 'assistant', 'routine-result:routine_run_abc'), message('m2', '[routine:我只是输入了这个字符串] completed Hello', 'user'), message('m3', '长内容'.repeat(34000))]);
  await expect(page.getByTestId('routine-result-card')).toContainText('Hello');
  await expect(page.getByTestId('routine-result-card').locator('details')).not.toHaveAttribute('open');
  await expect(page.locator('#playMessages').getByText('[routine:我只是输入了这个字符串] completed Hello', { exact: true })).toBeVisible();
  const long = page.getByTestId('long-message');
  await expect(long).toBeVisible();
  expect((await long.innerText()).length).toBeLessThan(5000);
  await long.getByRole('button').click();
  expect((await long.innerText()).length).toBeGreaterThan(100000);
});

test('whole information rail collapses without discarding the selected tab or draft [AC:bot-workspace-interaction-polish#AC-4] [AC:bot-workspace-interaction-polish#AC-17]', async ({ page }) => {
  await setup(page);
  await page.locator('#playInput').fill('保留');
  await page.getByRole('tab', { name: '工件', exact: true }).click();
  const before = await page.locator('.play-main-col').boundingBox();
  await page.getByRole('button', { name: '收起信息栏', exact: true }).click();
  await expect(page.locator('.play-rail')).toBeHidden();
  expect((await page.locator('.play-main-col').boundingBox())!.width).toBeGreaterThan(before!.width);
  await page.getByRole('button', { name: '展开信息栏', exact: true }).click();
  await expect(page.getByRole('tab', { name: '工件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#playInput')).toHaveValue('保留');
});

test('sidebar actions share a toolbar and groups use legible secondary text [AC:bot-workspace-interaction-polish#AC-5] [AC:bot-workspace-interaction-polish#AC-8]', async ({ page }) => {
  await setup(page);
  const toolbar = page.getByTestId('session-toolbar');
  await expect(toolbar.locator('#btnPlayCreate svg')).toHaveCount(1);
  await toolbar.getByRole('button', { name: '筛选会话', exact: true }).click();
  await page.getByLabel('筛选会话列表').fill('no match');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.locator('.session-item__title')).toContainText(bot.name);
  const heading = page.getByTestId('functional-group-ungrouped').locator('h3');
  expect(await heading.evaluate(el => getComputedStyle(el).color)).not.toBe(await page.locator('.session-item__title').evaluate(el => getComputedStyle(el).color));
});

test('schedule details distinguish schedule kinds and persist edits without executing [AC:bot-workspace-interaction-polish#AC-11] [AC:bot-workspace-interaction-polish#AC-12]', async ({ page }) => {
  let job = { id: 'cron-test', name: '每小时提醒', enabled: true, scheduleKind: 'cron5', scheduleValue: '0 * * * *', timezone: 'Asia/Shanghai' };
  await page.route('**/api/cron/jobs?botId=polish-bot', r => r.fulfill({ json: { jobs: [job, { ...job, id: 'once', name: '一次提醒', scheduleKind: 'once_at', enabled: false, scheduleValue: '2026-10-20T00:00:00Z' }] } }));
  await page.route('**/api/cron/jobs/cron-test', r => { const data = r.request().postDataJSON(); job = { ...job, scheduleValue: data.cron, timezone: data.timezone }; return r.fulfill({ json: { job } }); });
  await setup(page);
  await page.getByTestId('bot-detail-toggle').click();
  await expect(page.getByTestId('bot-detail-section-routines')).toContainText('一次性');
  await page.getByTestId('bot-detail-routine').first().getByRole('button', { name: '编辑计划' }).click();
  await page.getByLabel('Cron 表达式', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: '保存计划' }).click();
  await expect(page.getByTestId('bot-detail-routine').first().getByRole('alert')).toContainText('计划保存失败');
  expect(job.scheduleValue).toBe('0 * * * *');
  await page.getByLabel('Cron 表达式', { exact: true }).fill('30 * * * *');
  await page.getByRole('button', { name: '保存计划' }).click();
  await expect.poll(() => job.scheduleValue).toBe('30 * * * *');
  await expect(page.getByTestId('bot-detail-routine').first()).toContainText('30 * * * *');
});

test('Bot settings use tabs and memory content has collapsed sources [AC:bot-workspace-interaction-polish#AC-13] [AC:bot-workspace-interaction-polish#AC-14] [AC:bot-workspace-interaction-polish#AC-15]', async ({ page }) => {
  await page.route('**/api/memory?**', r => r.fulfill({ json: { entries: [{ id: 'mem1', key: 'compact:1-306', value: '用户偏好使用中文回复', scope: 'session.long', sourceRefs: [{ sessionId: sid, messageId: 'm1', seq: 1 }] }] } }));
  await page.route('**/api/sessions/polish-session/history/1', r => r.fulfill({ json: { messages: [message('m1', '原始来源内容', 'user')] } }));
  await setup(page);
  await page.goto('/#/agents/bots?bot=polish-bot&focus=permissions');
  const detail = page.getByTestId('bot-detail');
  await expect(detail.getByRole('tab', { name: '能力与权限' })).toHaveAttribute('aria-selected', 'true');
  await detail.getByRole('tab', { name: '历史与记忆' }).click();
  const memory = page.getByTestId('bot-memory');
  await expect(memory).toContainText('用户偏好使用中文回复');
  const sources = memory.getByTestId('memory-sources');
  await expect(sources).not.toHaveAttribute('open');
  await sources.locator('summary').click();
  await sources.getByRole('button').first().click();
  await expect(memory.getByTestId('memory-source-preview')).toContainText('原始来源内容');
});

test('new controls have translated names [AC:bot-workspace-interaction-polish#AC-18]', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: '收起信息栏' })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Collapse information panel' })).toBeVisible();
});

test('latest sent context is distinct from preview and missing upstream usage [AC:bot-workspace-interaction-polish#AC-9] [AC:bot-workspace-interaction-polish#AC-10]', async ({ page }) => {
  let estimatedTokens = 42000;
  await page.route('**/api/sessions/polish-session/context-snapshots*', r => r.fulfill({ json: { sessionId: sid, snapshots: [], latestRequest: { sessionId: sid, sentAt: '2026-10-21T01:00:00Z', estimatedTokens, windowTokens: 131072 } } }));
  await setup(page);
  await page.getByRole('tab', { name: '上下文', exact: true }).click();
  const metric = page.getByTestId('latest-request-metric');
  await expect(metric).toContainText('42,000');
  await expect(metric).toContainText('32.0%');
  await expect(metric).toContainText('未知');
  await expect(metric).not.toContainText('累计');
  estimatedTokens = 45000;
  await expect(metric).toContainText('45,000', { timeout: 3000 });
});

test('shared information persists and failed saves retain edits for retry [AC:bot-workspace-interaction-polish#AC-6] [AC:bot-workspace-interaction-polish#AC-7]', async ({ page }) => {
  let entries = { language: '中文' }, fail = true;
  await page.route('**/api/bot-shared-context?scope=global', r => {
    if (r.request().method() === 'PUT') {
      if (fail) return r.fulfill({ status: 500, json: { error: 'save failed' } });
      entries = r.request().postDataJSON().entries;
    }
    return r.fulfill({ json: { entries } });
  });
  await setup(page);
  const shared = page.locator('details').filter({ has: page.locator('summary', { hasText: '共享信息' }) });
  await shared.locator('summary').click();
  const value = shared.locator('input').nth(1);
  await expect(value).toHaveValue('中文');
  await value.fill('English');
  await shared.getByRole('button', { name: '保存共享信息' }).click();
  await expect(shared.getByRole('alert')).toBeVisible();
  await expect(value).toHaveValue('English');
  fail = false;
  await shared.getByRole('button', { name: '保存共享信息' }).click();
  await expect.poll(() => entries.language).toBe('English');
  await page.reload();
  await shared.locator('summary').click();
  await expect(shared.locator('input').nth(1)).toHaveValue('English');
});

test('large history stays responsive across scroll and rail resize [AC:bot-workspace-interaction-polish#AC-16] [AC:bot-workspace-interaction-polish#AC-17]', async ({ page }) => {
  const messages = Array.from({length: 2000}, (_, i) => message(`m${i + 1}`, i === 1999 ? '长消息'.repeat(34000) : `第 ${i + 1} 条消息\n` + '上下文测试内容。'.repeat(12)));
  await setup(page, messages);
  const feed = page.locator('#playMessages');
  await expect(page.getByTestId('long-message')).toBeVisible();
  for (let i = 0; i < 10; i++) {
    const started = Date.now();
    await feed.evaluate((el, index) => { el.scrollTop = el.scrollHeight * (0.3 + index * 0.03); }, i);
    await expect.poll(() => feed.locator('.chat-feed__row').count(), {timeout: 1000}).toBeGreaterThan(0);
    await page.locator('#playInput').fill(`草稿 ${i}`);
    await expect(page.locator('#playInput')).toHaveValue(`草稿 ${i}`);
    expect(Date.now() - started).toBeLessThan(1000);
  }
  expect(await feed.locator('.chat-feed__row').count()).toBeLessThan(60);
  // Exercise a clipped preceding row: its final pixel is not the reading anchor.
  await feed.evaluate(el => { const top=el.getBoundingClientRect().top; const row=Array.from(el.querySelectorAll('.chat-feed__row')).find(row=>row.getBoundingClientRect().bottom>top+1); if(row)el.scrollTop+=row.getBoundingClientRect().bottom-top-1; });
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const anchor = await feed.locator('.chat-feed__row').evaluateAll(rows => rows.find(row => row.getBoundingClientRect().bottom > document.querySelector('#playMessages')!.getBoundingClientRect().top + 1)?.getAttribute('data-feed-key'));
  const anchorTop = (await feed.locator(`[data-feed-key="${anchor}"]`).boundingBox())!.y;
  await page.getByRole('button', { name: '收起信息栏', exact: true }).click();
  await expect(feed.locator(`[data-feed-key="${anchor}"]`)).toBeVisible();
  await expect.poll(async () => Math.abs((await feed.locator(`[data-feed-key="${anchor}"]`).boundingBox())!.y - anchorTop)).toBeLessThan(2);
});

test('shared drafts survive scope switches [AC:bot-workspace-interaction-polish#AC-7]', async ({ page }) => {
  await setup(page);
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [{ id: 'group1', name: 'Research', botIds: [] }] } }));
  await page.route('**/api/bot-shared-context?**', r => r.fulfill({ json: { entries: { location: r.request().url().includes('global') ? 'global' : 'group' } } }));
  await page.reload();
  const shared = page.locator('details').filter({ has: page.locator('summary', { hasText: '共享信息' }) });
  await shared.locator('summary').click();
  await shared.locator('input').nth(1).fill('unsaved');
  await shared.locator('select').selectOption('group1');
  await expect(shared.locator('input').nth(1)).toHaveValue('group');
  await shared.locator('select').selectOption('global');
  await expect(shared.locator('input').nth(1)).toHaveValue('unsaved');
});

test('memory file sources preview registered files and report unavailable sources [AC:bot-workspace-interaction-polish#AC-14]', async ({ page }) => {
  await page.route('**/api/memory?**', r => r.fulfill({ json: { entries: [{ id:'file-memory',key:'note',value:'文件记录',scope:'session.long',source:'artifact:art1',sessionId:sid }] } }));
  await page.route('**/api/sessions/polish-session/artifacts', r => r.fulfill({ json:{ artifacts:[{id:'art1',fileName:'note.txt',mimeType:'text/plain',totalBytes:20}] } }));
  let available = true;
  await page.route('**/api/artifact/art1/download', r => available ? r.fulfill({ contentType:'text/plain',body:'真实文件内容' }) : r.fulfill({status:404}));
  await setup(page);
  await page.goto('/#/agents/bots?bot=polish-bot&focus=permissions');
  await page.getByTestId('bot-detail').getByRole('tab', {name:'历史与记忆'}).click();
  const memory = page.getByTestId('bot-memory');
  await memory.getByRole('button', {name:'查看来源文件'}).click();
  await expect(memory.getByTestId('memory-source-preview')).toContainText('真实文件内容');
  available = false;
  await memory.getByRole('button', {name:'查看来源文件'}).click();
  await expect(memory.getByRole('alert')).toContainText('来源不存在或无权查看');
});

test('ten session switches render long history within one second [AC:bot-workspace-interaction-polish#AC-16]', async ({ page }) => {
  await setup(page);
  const otherBot = {...bot,id:'polish-bot-2',name:'Second Bot',canonicalSessionId:'polish-session-2'};
  const otherSession = {...session,id:'polish-session-2',title:'Second Bot',metadata:{botId:otherBot.id,canonicalBotChat:true}};
  const history = Array.from({length:2000},(_,i)=>message(`m${i+1}`,i===1999?'长内容'.repeat(34000):`记录 ${i}`));
  await page.route('**/api/bots',r=>r.fulfill({json:{bots:[bot,otherBot]}}));
  await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[session,otherSession]}}));
  await page.route('**/api/bots/polish-bot-2/open',r=>r.fulfill({json:{bot:otherBot,session:otherSession}}));
  await page.route(/\/api\/sessions\/polish-session(?:-2)?(?:\?|$)/,r=>r.fulfill({json:{session:r.request().url().includes('session-2')?otherSession:session,messages:history}}));
  await page.reload();
  await page.locator('.session-item__title',{hasText:'Second Bot'}).click();
  await expect(page.getByTestId('long-message')).toBeVisible();
  for(let i=0;i<10;i++) {
    const name=i%2===0?'Polish Bot':'Second Bot';
    const start=Date.now();
    await page.locator('.session-item__title',{hasText:name}).click();
    await expect(page.getByTestId('long-message')).toBeVisible({timeout:1000});
    await expect(page.locator('.play-main .chat-panel-title')).toContainText(name,{timeout:1000});
    expect(Date.now()-start).toBeLessThan(1000);
  }
});

test('new menu remains usable when crossing from its icon to an item [AC:bot-workspace-interaction-polish#AC-5]', async ({ page }) => {
  await setup(page);
  await page.locator('#btnPlayCreate').click();
  const item = page.getByRole('menuitem', {name:'新建 Bot',exact:true});
  await expect(item).toBeVisible();
  const button = await page.locator('#btnPlayCreate').boundingBox();
  await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height + 2);
  await item.click({timeout:2000});
  await expect(page.getByRole('dialog')).toBeVisible();
});
