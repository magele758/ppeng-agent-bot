import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const bot = { id: 'menu-bot', name: 'Menu Bot', canonicalSessionId: 'menu-session', agentId: 'general' };
  const session = { id: bot.canonicalSessionId, title: bot.name, mode:'chat', status:'idle', agentId:'general', metadata:{botId:bot.id, canonicalBotChat:true} };
  await page.route('**/api/bots', r => r.fulfill({json:{bots:[bot]}}));
  await page.route('**/api/sessions', r => r.fulfill({json:{sessions:[session]}}));
  await page.route('**/api/bots/menu-bot/open', r => r.fulfill({json:{bot,session}}));
  await page.route('**/api/sessions/menu-session', r => r.fulfill({json:{session,messages:[]}}));
});

test('Bot 列表操作属于当前行 [AC:bot-row-menu#AC-1]', async ({page}) => {
  await page.goto('/#/bot');
  const trigger = page.getByTestId('bot-row-menu').first();
  await expect(trigger).toBeVisible({timeout:5000});
  await trigger.click();
  const actions = page.getByTestId('bot-row-actions');
  await expect(actions.getByRole('button')).toHaveCount(5);
  await actions.getByRole('button', {name:'查看定时任务'}).click();
  await expect(page.getByRole('dialog').getByTestId('bot-detail-tab-routines')).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Escape');
  await trigger.click();
  await actions.getByRole('button',{name:'查看详情'}).click();
  await expect(page.getByTestId('bot-detail-panel')).toBeVisible();
});

test('Bot 顶部精简并悬浮操作 [AC:bot-row-menu#AC-2]', async ({page}) => {
  await page.goto('/#/bot');
  await page.locator('.list-item--bot-chat').first().click();
  const header = page.locator('.chat-panel-header--bot:visible').first();
  await expect(header.locator('.chat-panel-header__actions')).toHaveCSS('position','absolute',{timeout:3000});
  await expect(header.locator('#playMeta')).toBeHidden();
  await header.locator('#playTitle button').click();
  await expect(page.getByTestId('bot-detail-panel')).toBeVisible();
});

test('分组与群聊写入选中的目标 [AC:bot-row-menu#AC-1]', async ({page}) => {
  const group = {id:'menu-team',name:'Menu team',botIds:[],roomIds:[]};
  const room = {id:'menu-room',title:'Menu room',botIds:[],status:'active'};
  await page.route('**/api/bot-functional-groups',r=>r.fulfill({json:{groups:[group]}}));
  await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[room]}}));
  await page.route('**/api/bots/*/functional-group',r=>r.fulfill({json:{ok:true}}));
  await page.route('**/api/bot-rooms/menu-room/members',r=>r.fulfill({json:{room}}));
  await page.goto('/#/bot');
  const trigger = page.getByTestId('bot-row-menu').first();
  const actions = page.getByTestId('bot-row-actions');
  for (const [action, target, suffix] of [['加入分组','Menu team','/functional-group'],['加入群聊','Menu room','/menu-room/members']]) {
    await trigger.click();
    await actions.getByRole('button',{name:action,exact:true}).click();
    const request = page.waitForRequest(req=>req.url().endsWith(suffix));
    await page.getByRole('dialog').getByRole('button',{name:target}).click();
    expect((await request).postDataJSON()).toEqual(action === '加入分组' ? {groupId:group.id} : {botId:expect.any(String)});
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});
