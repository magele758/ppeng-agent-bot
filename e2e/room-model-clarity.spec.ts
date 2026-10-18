import {test,expect} from '@playwright/test';

test('room displays the global default and each member model source with a settings entry [AC:global-default-model-clarity#AC-4]',async({page})=>{
 const {bots}=await (await page.request.get('/api/bots')).json();expect(bots.length).toBeGreaterThan(1);
 const room={id:'model-display-probe',title:'Model display probe',botIds:bots.slice(0,2).map((b:{id:string})=>b.id),status:'active',hostBotId:bots[0].id,maxBotTurns:2};
 const model={providerId:'test',providerName:'Probe provider',modelId:'Default-text-model'};
 await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[room]}}));
 await page.route('**/api/bot-rooms/model-display-probe',r=>r.fulfill({json:{room,models:{defaultModel:model,members:[{botId:room.botIds[0],model,source:'global'},{botId:room.botIds[1],model:{...model,modelId:'Pinned-text-model'},source:'bot'}]}}}));
 await page.route('**/api/bot-rooms/model-display-probe/messages*',r=>r.fulfill({json:{messages:[],hasMore:false,nextCursor:null}}));
 await page.route('**/api/bot-rooms/model-display-probe/turns',r=>r.fulfill({json:{turns:[]}}));
 await page.goto('/#/bot');await page.getByRole('button',{name:'打开群聊 Model display probe',exact:true}).click();
 const panel=page.getByTestId('play-group-chat');
 await expect(panel.getByTestId('room-default-model')).toContainText('Default-text-model');
 const header=panel.locator('.chat-panel-header');
 const titleBounds=await panel.getByRole('heading',{name:room.title,exact:true}).boundingBox();
 const headerBounds=await header.boundingBox();
 expect(titleBounds).not.toBeNull(); expect(headerBounds).not.toBeNull();
 expect(titleBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
 await expect(panel.getByTestId(`room-member-model-${room.botIds[0]}`)).toContainText('全局默认');
 await expect(panel.getByTestId(`room-member-model-${room.botIds[1]}`)).toContainText('Bot 专属');
 await expect(panel.getByTestId(`room-member-model-${room.botIds[1]}`)).toContainText('Pinned-text-model');
 await expect(panel.getByRole('link',{name:'设置全局默认模型'})).toHaveAttribute('href','#/settings/models');
});
