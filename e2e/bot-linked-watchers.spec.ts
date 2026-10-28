import {test,expect} from '@playwright/test';
test('Lab saves and reloads an original-work watcher [AC:bot-linked-watchers#AC-6]',async({page,request})=>{
 const {bot}=await(await request.post('/api/bots',{data:{name:`Linked watcher ${crypto.randomUUID()}`}})).json();
 try{
  const {session}=await(await request.post(`/api/bots/${bot.id}/open`)).json();
  const sent=await request.post(`/api/sessions/${session.id}/messages`,{data:{message:'请开发一个 watcher 验收用的小接口。',autoRun:true}});expect(sent.ok()).toBeTruthy();
  const readGoals=async()=> (await(await request.get(`/api/bots/${bot.id}/goals?sessionId=${session.id}`)).json()).goals;
  await expect.poll(async()=>(await readGoals()).length).toBeGreaterThan(0);const goal=(await readGoals())[0];
  await page.goto('/#/bot');await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
  await page.getByRole('tab',{name:'定时',exact:true}).click();
  await page.getByPlaceholder('例如：晨报').fill('Linked original work');await page.getByLabel('任务内容',{exact:true}).fill('Check current authorized work');
  await page.getByLabel('原工作目标',{exact:true}).selectOption(goal.id);await page.getByLabel('当前 SOP 技能名或 ID（可选）',{exact:true}).fill('current-delivery-sop');
  await page.getByRole('button',{name:'添加定时任务',exact:true}).click();
  await expect(page.getByPlaceholder('例如：晨报')).toHaveValue('');
  const readJobs=async()=> (await(await request.get(`/api/cron/jobs?botId=${bot.id}`)).json()).jobs;
  const job=(await readJobs()).find((j:{name:string})=>j.name==='Linked original work');expect(job.metadata.workLink).toEqual({goalId:goal.id,sopSkill:'current-delivery-sop'});
  await page.reload();await page.getByRole('tab',{name:'定时',exact:true}).click();
  const card=page.getByTestId('bot-detail-routine').filter({hasText:'Linked original work'});await card.getByRole('button',{name:'修改',exact:true}).click();
  await expect(page.getByLabel('原工作目标',{exact:true})).toHaveValue(goal.id);await expect(page.getByLabel('当前 SOP 技能名或 ID（可选）',{exact:true})).toHaveValue('current-delivery-sop');
  await request.delete(`/api/cron/jobs/${job.id}`);
 }finally{await request.patch(`/api/bots/${bot.id}`,{data:{hidden:true}});}
});
