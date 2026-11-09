import { expect, test } from '@playwright/test';

test('opened Bot shows history while the task list is pending [AC:history-startup-contention#AC-3]', async ({ page }) => {
  const bot = { id: 'history-bot', name: 'History', agentId: 'general', canonicalSessionId: 'history-chat' };
  const session = { id: bot.canonicalSessionId, title: bot.name, status: 'idle', mode: 'chat', agentId: bot.agentId, metadata: { botId: bot.id, canonicalBotChat: true } };
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'offline' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { loginRequired: false } }));
  const opened = page.waitForResponse(r => r.url().endsWith('/api/bots/history-bot/open'));
  const tasks = page.waitForRequest(r => r.url().endsWith('/api/tasks'));
  await page.route('**/api/bot-work/default', route => route.fulfill({ json: { bot } }));
  await page.route('**/api/bots/history-bot/open', route => route.fulfill({ json: { bot, session } }));
  await page.route('**/api/bots', route => route.fulfill({ json: { bots: [bot] } }));
  await page.route(url => url.pathname === '/api/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(url => url.pathname === '/api/sessions/history-chat', route => route.fulfill({ json: {
    session, messages: [{ id: 'msg', seq: 1, role: 'user', parts: [{ type: 'text', text: 'Previously saved message' }] }]
  } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => { await pending; await route.fulfill({ json: { tasks: [] } }); });
  try {
    await page.goto('/#/bot');
    await Promise.all([opened, tasks]);
    await expect(page.locator('.chat-bubble').filter({ hasText: 'Previously saved message' }).first()).toBeVisible({ timeout: 5000 });
  } finally {
    release();
  }
});

test('sidebar fetches visible questions and switching only loads the selected chat [AC:bot-sidebar-load#AC-1] [AC:bot-sidebar-load#AC-2]', async ({ page }) => {
  const bots = Array.from({ length: 48 }, (_, i) => ({ id: 'row-'+i, name: 'Sidebar '+i, agentId:'general', canonicalSessionId:'chat-'+i }));
  const sessions = bots.map(b => ({ id:b.canonicalSessionId, title:b.name, agentId:b.agentId, status:'idle', mode:'chat', metadata:{botId:b.id,canonicalBotChat:true} }));
  const questions = new Set<string>();
  let taskReads = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[3];
    const session = sessions.find(s=>s.id===id);
    const message = {id:'m-'+id,seq:1,role:'user',parts:[{type:'text',text:'Question '+id}]};
    let json: unknown;
    if (url.pathname==='/api/auth/me') json={loginRequired:false};
    if (url.pathname==='/api/bots') json={bots};
    if (url.pathname==='/api/sessions') json={sessions};
    if (url.pathname==='/api/tasks') { taskReads++; json={tasks:[]}; }
    if (url.pathname==='/api/bot-work/default' || url.pathname.endsWith('/open')) json={bot:bots[0],session:sessions[0]};
    if (url.pathname==='/api/bot-functional-groups') json={groups:[]};
    if (session && (url.pathname==='/api/sessions/'+id || url.pathname.endsWith('/history'))) json={session,messages:[message]};
    if (session && url.pathname.endsWith('/history') && url.searchParams.get('limit')==='4') questions.add(id);
    await route.fulfill(json ? {json} : {status:503,json:{error:'offline'}});
  });
  await page.goto('/#/bot');
  const rows=page.locator('#sessionListMini [data-session-id]');
  await expect(rows).toHaveCount(bots.length);
  await expect(page.locator('#playMessages')).toContainText('Question chat-0');
  const last=rows.last(), lastId=await last.getAttribute('data-session-id');
  await expect(rows.first().locator('.session-item__question-text')).toContainText('Question');
  expect(questions.has(lastId!)).toBe(false);
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('.session-item__question-text')).toContainText('Question '+lastId);
  const before=taskReads;
  await last.click();
  await expect(page.locator('#playMessages')).toContainText('Question '+lastId);
  expect(taskReads).toBe(before);
});
