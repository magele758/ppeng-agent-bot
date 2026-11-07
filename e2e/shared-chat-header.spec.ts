import {test,expect} from '@playwright/test';

test('普通会话统一浮层 [AC:shared-chat-header#AC-1]',async({page})=>{
 const session={id:'header-chat',title:'Header Chat',mode:'chat',status:'idle',agentId:'general',metadata:{}};
 await page.route(url => url.pathname === '/api/sessions',r=>r.fulfill({json:{sessions:[session]}}));
 await page.route('**/api/sessions/header-chat',r=>r.fulfill({json:{session,messages:[]}}));
 await page.goto('/#/chat');
 await page.locator('[data-session-id="header-chat"]').first().click();
 const header=page.locator('.chat-panel-header:visible').first();
 await expect(header).toHaveCSS('position','absolute');
 await expect(header.locator('#playMeta')).toBeHidden();
 await header.getByRole('button',{name:'更多',exact:true}).click();
 await expect(header.getByRole('menuitem',{name:/信息栏/})).toBeVisible();
 await expect(header.locator('#btnRunSession, #btnCancelSession')).toHaveCount(0);
});

test('群聊设置收进统一菜单 [AC:shared-chat-header#AC-2]',async({page})=>{
 const room={id:'header-room',title:'Header Room '+ '长群聊名称'.repeat(12),botIds:[],status:'active'};
 await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[room]}}));
 await page.route('**/api/bot-rooms/header-room',r=>r.fulfill({json:{room}}));
 await page.route('**/api/bot-rooms/header-room/messages*',r=>r.fulfill({json:{messages:[],hasMore:false}}));
 await page.route('**/api/bot-rooms/header-room/turns',r=>r.fulfill({json:{turns:[]}}));
 await page.goto('/#/bot');
 await page.getByTestId('play-group-row').filter({hasText:'Header Room'}).first().click();
 const panel=page.getByTestId('play-group-chat');
 const header=panel.locator('header.chat-panel-header');
 await expect(header).toHaveCSS('position','absolute');
 await expect(header.getByRole('button',{name:'群聊设置',exact:true})).toBeHidden();
 await header.getByRole('button',{name:'更多',exact:true}).click();
 await expect(header.getByTestId('room-default-model')).toHaveAttribute('href','#/settings/models');
 await header.getByRole('button',{name:'群聊设置',exact:true}).click();
 await expect(panel.getByTestId('room-settings')).toBeVisible();
 for(const width of [1280,360]) {
   await page.setViewportSize({width,height:804});
   const title=await header.locator('.chat-panel-header__text').boundingBox();
   const actions=await header.locator('.chat-panel-header__actions').boundingBox();
   expect(title!.x+title!.width).toBeLessThanOrEqual(actions!.x);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 }
 await page.screenshot({path:'/tmp/shared-group-header.png'});
});
