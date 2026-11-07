import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(()=>localStorage.setItem('lab.botPins',JSON.stringify({ids:[],roomIds:[],customized:true})));
  const bot = { id: 'menu-bot', name: 'Menu Bot', canonicalSessionId: 'menu-session', agentId: 'general' };
  const session = { id: bot.canonicalSessionId, title: bot.name, mode:'chat', status:'idle', agentId:'general', metadata:{botId:bot.id, canonicalBotChat:true} };
  await page.route('**/api/bot-functional-groups', r => r.fulfill({json:{groups:[]}}));
  await page.route('**/api/user/preferences', r => r.fulfill({json:{scope:'menu-test',values:{'lab.locale':'zh','lab.botPins':JSON.stringify({ids:[],roomIds:[],customized:true})}}}));
  await page.route('**/api/bots', r => r.fulfill({json:{bots:[bot]}}));
  await page.route(url => url.pathname === '/api/sessions', r => r.fulfill({json:{sessions:[session]}}));
  await page.route('**/api/bots/menu-bot/open', r => r.fulfill({json:{bot,session}}));
  await page.route(url => url.pathname === '/api/sessions/menu-session', r => r.fulfill({json:{session,messages:[]}}));
});

test('Bot 列表操作属于当前行 [AC:bot-row-menu#AC-1]', async ({page}) => {
  await page.goto('/#/bot');
  const trigger = page.getByRole('button',{name:'Menu Bot 的更多操作',exact:true}).first();
  await expect(trigger).toBeVisible({timeout:5000});
  await trigger.click();
  const actions = page.getByTestId('bot-row-actions');
  await expect(actions.getByRole('button')).toHaveCount(6);
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
  const trigger = page.getByRole('button',{name:'Menu Bot 的更多操作',exact:true}).first();
  const actions = page.getByTestId('bot-row-actions');
  for (const [action, target, suffix] of [['加入分组','Menu team','/functional-group'],['加入群聊','Menu room','/menu-room/members']]) {
    await trigger.click();
    await actions.getByRole('button',{name:action,exact:true}).click();
    const refreshed = action==='加入分组' ? page.waitForResponse(res=>res.url().endsWith('/api/bot-functional-groups')) : Promise.resolve();
    const request = page.waitForRequest(req=>req.url().endsWith(suffix));
    await page.getByRole('dialog').getByRole('button',{name:target}).click();
    expect((await request).postDataJSON()).toEqual(action === '加入分组' ? {groupId:group.id} : {botId:expect.any(String)});
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await refreshed;
  }
});

test('隐藏操作只出现在菜单且允许取消 [AC:bot-row-menu#AC-3]', async ({page}) => {
  await page.goto('/#/bot');
  const row = page.locator('.list-item--bot-chat').filter({has:page.getByTestId('bot-row-menu')}).first();
  await row.hover();
  await expect(row.locator('.session-item__delete')).toHaveCount(0);
  await row.getByTestId('bot-row-menu').click();
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('隐藏');
    await dialog.dismiss();
  });
  await page.getByTestId('bot-row-actions').getByRole('button',{name:'隐藏 Bot',exact:true}).click();
  await expect(row).toBeVisible();
});

test('目标弹窗长列表在小屏内滚动 [AC:bot-row-menu#AC-4]', async ({page}) => {
  await page.route('**/api/bot-functional-groups',r=>r.fulfill({json:{groups:Array.from({length:30},(_,i)=>({id:String(i),name:'功能分组 '+i,botIds:[]}))}}));
  await page.goto('/#/bot');
  await page.getByTestId('bot-row-menu').first().click();
  await page.getByTestId('bot-row-actions').getByRole('button',{name:'加入分组',exact:true}).click();
  const dialog=page.getByRole('dialog');
  for (const width of [907,360]) {
    await page.setViewportSize({width,height:640});
    const box=await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(480);
    expect(box!.x).toBeGreaterThanOrEqual(12);
    await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeInViewport();
    const list=dialog.locator('.bot-row-dialog__body');
    await expect(list).toHaveCSS('overflow-y','auto');
    await expect(dialog.locator('.bot-row-dialog__head')).toHaveCSS('padding-left','24px');
    await list.evaluate(node=>node.scrollTop=node.scrollHeight);
    await expect(dialog.getByRole('button',{name:'功能分组 29',exact:true})).toBeInViewport();
    await page.screenshot({path:`/tmp/bot-menu-modal-${width}.png`});
  }
});

test('标题浮层和低干扰摘要 [AC:chat-floating-chrome#AC-1] [AC:chat-floating-chrome#AC-2]', async ({page}) => {
  await page.goto('/#/bot');
  const row=page.locator('.list-item--bot-chat').first();
  await row.click();
  const header=page.locator('.chat-panel-header--bot:visible').first();
  await expect(header).toHaveCSS('position','absolute',{timeout:1500});
  await expect(row).toHaveCSS('border-radius','0px');
  await expect(row).toHaveCSS('border-top-width','0px');
  await page.evaluate(() => {
    const recap=document.createElement('div');
    recap.className='session-recap';
    recap.textContent='摘要';
    document.querySelector('.chat-panel-body')!.append(recap);
  });
  await expect(page.locator('.session-recap').last()).toHaveCSS('border-top-width','0px');
});

test('删除 Bot 明确保留记录且可取消 [AC:bot-delete#AC-3]', async ({page})=>{
  await page.goto('/#/bot');
  const trigger=page.getByRole('button',{name:'Menu Bot 的更多操作',exact:true}).first();
  await trigger.click();
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('保留');await dialog.dismiss();});
  await page.getByTestId('bot-row-actions').getByRole('button',{name:'删除 Bot',exact:true}).click();
  await expect(trigger).toBeVisible();
  await page.route('**/api/bots/menu-bot',r=>r.fulfill({status:409,json:{error:'Task still running'}}));
  await trigger.click();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByTestId('bot-row-actions').getByRole('button',{name:'删除 Bot',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Task still running'})).toBeVisible();
});

test('顶部操作统一在更多菜单 [AC:chat-header-menu-only#AC-1]',async({page})=>{
  await page.goto('/#/bot');
  await page.locator('.list-item--bot-chat').first().click();
  const header=page.locator('.chat-panel-header--bot:visible').first();
  await expect(header.locator(':scope > .chat-panel-header__actions > .rail-toggle')).toHaveCount(0);
  await expect(header.locator('#btnCancelSession')).toHaveCount(0);
  const more=header.locator('.more-menu > button');
  await more.click();
  await expect(header.locator('#btnRunSession')).toHaveCount(0);
  const toggle=header.getByRole('menuitem',{name:/信息栏/});
  const initial=await toggle.getAttribute('aria-expanded');
  await toggle.click();
  await more.click();
  await expect(toggle).toHaveAttribute('aria-expanded',String(initial!=='true'));
  await toggle.click();
  await more.click();
  await expect(toggle).toHaveAttribute('aria-expanded',initial!);
});
