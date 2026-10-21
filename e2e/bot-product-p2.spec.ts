import {test,expect} from '@playwright/test';

test('completed task becomes a persisted routine with inputs, destination, timezone and notification rules [AC:bot-product-p2#AC-7]',async({page,request})=>{
 const {bot}=await(await request.post('/api/bots',{data:{name:`Routine source ${crypto.randomUUID()}`}})).json();
 const {task}=await(await request.post('/api/bot-work/tasks',{data:{targetBotId:bot.id,input:'Summarize project progress'}})).json();
 await expect.poll(async()=> (await(await request.get(`/api/bot-work/tasks/${task.id}`)).json()).task.status).toBe('completed');
 const {room}=await(await request.post('/api/bot-rooms',{data:{title:'Report destination',botIds:[bot.id]}})).json();
 await page.goto('/#/tasks/bots');
 const panel=page.getByTestId('bot-team-work');
 const open=async()=>{await panel.locator('article').filter({hasText:bot.name}).getByRole('button',{name:'详情',exact:true}).click();await panel.getByRole('button',{name:'保存为例行任务',exact:true}).click();};
 await open();const routine=panel.locator('.bot-cron-panel');
 await expect(routine.getByLabel('任务内容',{exact:true})).toHaveValue('Summarize project progress');
 await routine.getByLabel('名称',{exact:true}).fill('Reusable report');
 await routine.getByLabel('输入来源',{exact:true}).fill('Project changelog');
 await routine.getByLabel('输出位置',{exact:true}).selectOption(room.id);
 await routine.getByLabel('时区',{exact:true}).fill('Asia/Shanghai');
 await routine.getByLabel('仅结果变化时通知',{exact:true}).check();
 await routine.getByLabel('连续失败多少次后提醒',{exact:true}).fill('3');
 await routine.getByLabel('报告发送前由我审批',{exact:true}).check();
 await routine.getByRole('button',{name:'添加定时任务',exact:true}).click();
 await expect(routine.locator('article').filter({hasText:'Reusable report'})).toBeVisible();
 const {jobs}=await(await request.get(`/api/cron/jobs?botId=${bot.id}`)).json();
 expect(jobs[0].metadata.sourceDelivery).toEqual({taskId:task.id,attempt:1});
 expect(jobs[0].metadata.roomId).toBe(room.id);
 await page.reload();await open();
 await routine.locator('article').filter({hasText:'Reusable report'}).getByRole('button',{name:'修改',exact:true}).click();
 await expect(routine.getByLabel('输入来源',{exact:true})).toHaveValue('Project changelog');
 await expect(routine.getByLabel('输出位置',{exact:true})).toHaveValue(room.id);
 await expect(routine.getByLabel('时区',{exact:true})).toHaveValue('Asia/Shanghai');
 await expect(routine.getByLabel('仅结果变化时通知',{exact:true})).toBeChecked();
 await expect(routine.getByLabel('连续失败多少次后提醒',{exact:true})).toHaveValue('3');
 await expect(routine.getByLabel('报告发送前由我审批',{exact:true})).toBeChecked();
});

test('delegated members appear under one goal with collected deliveries [AC:bot-product-p2#AC-5]',async({page,request})=>{
 const create=async(name:string)=>(await(await request.post('/api/bots',{data:{name:`${name} ${crypto.randomUUID()}`}})).json()).bot;
 const boss=await create('Coordinator'),worker=await create('Member');
 const goal=`Unified launch report ${crypto.randomUUID()}`;
 const root=(await(await request.post('/api/bot-work/tasks',{data:{targetBotId:boss.id,input:goal}})).json()).task;
 await expect.poll(async()=> (await(await request.get(`/api/bot-work/tasks/${root.id}`)).json()).task.status).toBe('completed');
 const child=(await(await request.post('/api/bot-work/tasks',{data:{requesterBotId:boss.id,targetBotId:worker.id,parentTaskId:root.id,input:'Verify release notes'}})).json()).task;
 await expect.poll(async()=> (await(await request.get(`/api/bot-work/tasks/${child.id}`)).json()).task.status).toBe('completed');
 await page.goto('/#/tasks/bots');
 const group=page.getByTestId('collaboration-summary').filter({hasText:goal});
 await expect(group).toContainText('已完成 2 / 2 项');await expect(group).toContainText('汇总交付');
 await group.getByText('展开成员工作与恢复操作',{exact:true}).click();
 await expect(group.getByRole('button',{name:'详情',exact:true})).toHaveCount(2);
});

test('blocked collaboration exposes partial output and only retries the affected member [AC:bot-product-p2#AC-6]',async({page})=>{
 let recovered=false;const retried:string[]=[];
 const good={id:'done',targetBotId:'writer',input:'Write report',status:'completed',result:'Report already delivered'};
 const bad=()=>({id:'broken',targetBotId:'reviewer',input:'Verify report',status:recovered?'completed':'failed',failureReason:recovered?undefined:'Connection unavailable'});
 await page.route('**/api/bot-work/tasks?*',route=>route.fulfill({json:{tasks:[good,bad()],activeTasks:[],historyTasks:[good,bad()],collaborations:[{id:'group',goal:'Deliver verified report',status:recovered?'completed':'blocked',completed:recovered?2:1,total:2,members:[good,bad()],blockers:recovered?[]:[bad()],deliveries:[good]}]}}));
 await page.route('**/api/bot-work/tasks/broken',route=>route.fulfill({json:{task:bad()}}));
 await page.route('**/api/bot-work/tasks/*/retry',route=>{retried.push(route.request().url().split('/').at(-2)!);recovered=true;return route.fulfill({json:{task:bad()}});});
 await page.goto('/#/tasks/bots');const group=page.getByTestId('collaboration-summary');
 await expect(group).toContainText('部分工作受阻');await expect(group).toContainText('Connection unavailable');await expect(group).toContainText('Report already delivered');
 await group.getByText('展开成员工作与恢复操作',{exact:true}).click();
 await group.locator('article').filter({hasText:'Verify report'}).getByRole('button',{name:'详情',exact:true}).click();
 await page.getByTestId('bot-team-work').locator('aside').getByRole('button',{name:'重试',exact:true}).click();
 await expect(group).toContainText('已完成 2 / 2 项');expect(retried).toEqual(['broken']);
});

test('routine report can be reviewed and approved without re-executing the task [AC:bot-product-p2#AC-7]',async({page,request})=>{
 const {bot}=await(await request.post('/api/bots',{data:{name:`Publish report ${crypto.randomUUID()}`}})).json();
 const {task}=await(await request.post('/api/bot-work/tasks',{data:{targetBotId:bot.id,input:'Prepare report'}})).json();
 await expect.poll(async()=> (await(await request.get(`/api/bot-work/tasks/${task.id}`)).json()).task.status).toBe('completed');
 const {room}=await(await request.post('/api/bot-rooms',{data:{title:'Approved report destination',botIds:[bot.id]}})).json();
 const {job}=await(await request.post('/api/cron/jobs',{data:{botId:bot.id,name:'Review publication',prompt:'Reply with a report',onceAt:new Date(Date.now()+1000).toISOString(),roomId:room.id,deliveryPolicy:{inputSources:'Current project',changesOnly:true,failureThreshold:2,approvalBeforeSend:true}}})).json();
 let runId='';await expect.poll(async()=>{const {runs}=await(await request.get(`/api/cron/jobs/${job.id}/runs`)).json();runId=runs[0]?.id??'';return runs[0]?.publication;},{timeout:20000}).toBe('pending');
 expect((await(await request.get(`/api/bot-rooms/${room.id}/messages`)).json()).messages).toHaveLength(0);
 await page.goto('/#/tasks/bots');const panel=page.getByTestId('bot-team-work');
 await panel.locator('article').filter({hasText:bot.name}).getByRole('button',{name:'详情',exact:true}).click();await panel.getByRole('button',{name:'保存为例行任务',exact:true}).click();
 const card=panel.locator('.bot-cron-panel article').filter({hasText:'Review publication'});
 await card.getByRole('button',{name:'运行记录',exact:true}).click();await expect(card).toContainText('报告待发送');
 await card.getByRole('button',{name:'批准发送此报告',exact:true}).click();
 await expect.poll(async()=> (await(await request.get(`/api/bot-rooms/${room.id}/messages`)).json()).messages.length).toBe(1);
 const {run}=await(await request.get(`/api/cron/runs/${runId}`)).json();expect(run.attempt).toBe(1);expect(run.publication).toBe('approved');
});
