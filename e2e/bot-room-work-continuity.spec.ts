import {test,expect} from '@playwright/test';
test('group acceptance is localized and opens the original Bot work [AC:bot-room-work-continuity#AC-6]',async({page,request})=>{
 const bots=[];for(const name of ['Coordinator','Worker']){const r=await request.post('/api/bots',{data:{name:`${name}-${crypto.randomUUID()}`}});expect(r.ok()).toBeTruthy();bots.push((await r.json()).bot);}
 const {room}=await(await request.post('/api/bot-rooms',{data:{title:`Work-${crypto.randomUUID()}`,botIds:bots.map(b=>b.id),maxBotTurns:1}})).json();
 try{
  expect((await request.patch(`/api/bot-rooms/${room.id}`,{data:{replyMode:'task-collaboration'}})).ok()).toBeTruthy();
  const accepted=await(await request.post(`/api/bot-rooms/${room.id}/messages`,{data:{text:'请开发一个本地验收接口。',mentions:[bots[1].id],idempotencyKey:'ui-work'}})).json();expect(accepted.turn.workRef.goalId).toBeTruthy();
  await page.goto('/#/bot');await page.getByRole('button',{name:`打开群聊 ${room.title}`,exact:true}).click();
  const receipt=page.getByTestId('room-work-receipt').filter({hasText:'已接收工作'});await expect(receipt).toBeVisible();await expect(receipt).toContainText('讨论结束不代表工作已交付');
  await page.evaluate(()=>{localStorage.setItem('lab.locale','en');});await page.reload();await page.getByRole('button',{name:`Open group chat ${room.title}`,exact:true}).click();
  const english=page.getByTestId('room-work-receipt').filter({hasText:'Work accepted'});await expect(english).toBeVisible();await expect(english).toContainText('Ending the discussion does not mean delivery is complete');
  await english.getByRole('button',{name:'Open original work',exact:true}).click();await expect(page.locator(`#sessionListMini [data-bot-id="${bots[1].id}"]`)).toBeVisible();
  await expect(page.getByTestId('play-group-chat')).not.toBeVisible();
 }finally{await request.delete(`/api/bot-rooms/${room.id}`);for(const bot of bots)await request.patch(`/api/bots/${bot.id}`,{data:{hidden:true}});}
});
