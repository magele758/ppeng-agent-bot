import { test, expect } from './helpers/bot-pair';

test('task contract saves through Lab and cache usage remains explicitly unknown [AC:always-on-reliability#AC-4] [AC:always-on-reliability#AC-5]',async({page,request,botPair})=>{
 const bot=botPair[0];
 await page.goto('/#/bot');
 await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
 await page.getByRole('tab',{name:'上下文',exact:true}).click();
 await page.getByText('长期任务与缓存诊断',{exact:true}).click();
 await page.getByLabel('目标',{exact:true}).fill('Draft a report');
 await page.getByLabel('约束与授权边界',{exact:true}).fill('Do not send');
 await page.getByLabel('证据引用（消息或文件）',{exact:true}).fill('message:original');
 await page.getByRole('button',{name:'保存任务契约',exact:true}).click();
 await expect(page.getByText('契约版本 1',{exact:false})).toBeVisible();
 const response=await request.get(`/api/sessions/${bot.canonicalSessionId}/reliability`);
 expect(response.ok()).toBeTruthy();expect((await response.json()).contract.constraints).toEqual(['Do not send']);
 await page.reload();
 await page.getByRole('tab',{name:'上下文',exact:true}).click();
 await page.getByText('长期任务与缓存诊断',{exact:true}).click();
 await expect(page.getByLabel('约束与授权边界',{exact:true})).toHaveValue('Do not send');
 await expect(page.getByText('未知',{exact:true})).toBeVisible();
});

test('routine attention policy persists from Lab [AC:always-on-reliability#AC-2]',async({page,request,botPair})=>{
 const bot=botPair[0];
 await page.goto('/#/bot');
 await page.locator(`#sessionListMini [data-bot-id="${bot.id}"] .list-item--session`).click();
 await page.getByRole('tab',{name:'定时',exact:true}).click();
 await page.getByPlaceholder('例如：晨报').fill('Attention policy test');
 await page.getByLabel('任务内容',{exact:true}).fill('Report structured facts');
 await page.getByLabel('仅结果变化时通知',{exact:true}).check();
 await page.getByLabel('按结构化事实比较变化',{exact:true}).check();
 await page.getByLabel('启用安静时段（任务时区；延迟结果合并）',{exact:true}).check();
 await page.getByLabel('每日通知上限（0 为不限）',{exact:true}).fill('3');
 await page.getByRole('button',{name:'添加定时任务',exact:true}).click();
 await expect(page.getByPlaceholder('例如：晨报')).toHaveValue('');
 const data=await (await request.get(`/api/cron/jobs?botId=${bot.id}`)).json();
 const job=data.jobs.find((j:{name:string})=>j.name==='Attention policy test');
 expect(job.metadata.deliveryPolicy).toMatchObject({changesOnly:true,comparison:'facts',quietStart:22,quietEnd:8,dailyBudget:3});
 await request.delete(`/api/cron/jobs/${job.id}`);
});
