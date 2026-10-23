import {test,expect} from './helpers/bot-pair';

test('room keeps a short model settings link and shows only a different member model [AC:global-default-model-clarity#AC-4] [AC:group-member-quiet#AC-1] [AC:group-member-quiet#AC-2] [AC:group-member-quiet#AC-3] [AC:group-member-quiet#AC-4] [AC:group-member-quiet#AC-5]',async({page,botPair:bots})=>{
 expect(bots.length).toBeGreaterThan(1);
 const room={id:'model-display-probe',title:'Model display probe',botIds:bots.slice(0,2).map((b:{id:string})=>b.id),status:'active',hostBotId:bots[0].id,maxBotTurns:2};
 const model={providerId:'test',providerName:'Probe provider',modelId:'Default-text-model'};
 await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[room]}}));
 await page.route('**/api/bot-rooms/model-display-probe',r=>r.fulfill({json:{room,models:{defaultModel:model,members:[{botId:room.botIds[0],model,source:'global'},{botId:room.botIds[1],model:{...model,modelId:'Pinned-text-model'},source:'bot'}]}}}));
 await page.route('**/api/bot-rooms/model-display-probe/messages*',r=>r.fulfill({json:{messages:[],hasMore:false,nextCursor:null}}));
 await page.route('**/api/bot-rooms/model-display-probe/turns',r=>r.fulfill({json:{turns:[]}}));
 await page.goto('/#/bot');await page.getByRole('button',{name:'打开群聊 Model display probe',exact:true}).click();
 const panel=page.getByTestId('play-group-chat');
 const header=panel.locator('.chat-panel-header');
 const titleBounds=await panel.getByRole('heading',{name:room.title,exact:true}).boundingBox();
 const headerBounds=await header.boundingBox();
 expect(titleBounds).not.toBeNull(); expect(headerBounds).not.toBeNull();
 expect(titleBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y);
 await expect(panel.getByTestId('room-default-model')).toHaveText('默认模型');
 await expect(panel.getByRole('link',{name:'默认模型'})).toHaveAttribute('href','#/settings/models');
 await expect(header).not.toContainText('Default-text-model');
 await expect(header).not.toContainText('全局默认模型');
 await expect(panel.getByText('这里展示普通文本模型配置')).toHaveCount(0);
 await expect(panel.getByText(/群成员优先使用/)).toHaveCount(0);
 await expect(panel.locator('.play-group-member__desc')).toHaveCount(0);
 await expect(panel.getByTestId(`room-member-model-${room.botIds[0]}`)).toHaveCount(0);
 const pinned=panel.locator('.play-group-member').filter({has:panel.getByTestId(`room-member-model-${room.botIds[1]}`)});
 await expect(pinned.getByTestId(`room-member-model-${room.botIds[1]}`)).toHaveText('Pinned-text-model');
 await expect(pinned).not.toContainText('全局默认');
 await expect(pinned).not.toContainText('Bot 专属');
 await expect(pinned).not.toContainText('Probe provider');
 for (const bot of bots.slice(0,2)) {
  const desc=(bot.description??'').replace(/\s+/g,' ').trim();
  if (desc.length>0) await expect(panel.locator('.play-group-member').filter({hasText:bot.name})).not.toContainText(desc.slice(0,40));
 }
 await expect(panel.getByRole('button',{name:'移出'}).first()).toBeVisible();
 await expect(panel.getByLabel('加入 Bot')).toBeVisible();
 await expect(panel.getByTestId('room-shared-context')).toBeVisible();
});
