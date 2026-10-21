import { test, expect, type APIRequestContext } from '@playwright/test';

const ownedJobs: string[] = [];
// The shared E2E daemon fills the ordinary roster (hidden Bots still count).
// These checks need a Bot that already exists, so they use the built-in Super Bot.
async function reliabilityBot(request: APIRequestContext) {
 const response = await request.get('/api/bot-work/default');
 expect(response.ok(), await response.text()).toBeTruthy();
 const { bot } = await response.json();
 expect(bot?.id).toEqual(expect.any(String));
 return bot;
}
test.afterEach(async ({request}) => {
 for (const id of ownedJobs.splice(0)) expect((await request.delete(`/api/cron/jobs/${id}`)).ok()).toBeTruthy();
});

test('delete and explicitly remember from Lab [AC:memory-deletion-suppression#AC-1] [AC:memory-deletion-suppression#AC-6]', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  const key = `suppression-${Date.now()}`;
  const created = await request.post('/api/memory', { data: { scope: 'user.memory', namespace: 'default', key, value: '用户偏好简洁回答' } });
  expect(created.ok()).toBeTruthy();
  await page.goto('/#/knowledge/memory');
  await page.locator('#memorySearch').fill(key);
  const row = page.locator('#listMemory .list-item').filter({ hasText: key });
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await row.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  const suppressed = page.getByTestId('memory-suppressions').locator('article').filter({ hasText: key });
  await expect(suppressed).toContainText('阻止自动学习');
  await suppressed.getByRole('button', { name: '重新记住', exact: true }).click();
  await expect(row).toHaveCount(1);
  await expect(suppressed).toHaveCount(0);
});

test('Lab explicitly upgrades a legacy precheck [AC:routine-strict-precheck#AC-1]',async({page,request})=>{
 await page.addInitScript(()=>localStorage.setItem('lab.locale','zh'));
 const bot=await reliabilityBot(request);
 const {job}=await (await request.post('/api/cron/jobs',{data:{botId:bot.id,name:'strict-check',prompt:'inspect',intervalMs:60000,precheck:{kind:'predicate',source:'{"wakeAgent":false}',mode:'compat'}}})).json();
 ownedJobs.push(job.id);
 await page.goto('/#/agents/bots');
 await page.getByRole('searchbox', { name: '搜索 Bot' }).fill(bot.name);
 await page.getByTestId(`bot-card-${bot.id}`).click();
 await page.getByTestId('bot-detail').getByRole('tab',{name:'任务与自动化'}).click();
 const panel=page.locator('.bot-cron-panel');await panel.getByRole('button',{name:'修改',exact:true}).click();
 const mode=panel.getByTestId('strict-precheck-mode');await expect(mode).toHaveValue('compat');await mode.selectOption('strict');
 await panel.locator('button[type=submit]').click();
 await expect.poll(async()=>{const data=await(await request.get('/api/cron/jobs')).json();return data.jobs.find((x:{id:string})=>x.id===job.id)?.metadata.precheckMode;}).toBe('strict');
});

test('private task center saves policy and explicitly resumes [AC:routine-failure-governance#AC-1] [AC:routine-failure-governance#AC-8]',async({page,request})=>{
 await page.addInitScript(()=>localStorage.setItem('lab.locale','zh'));
 const bot=await reliabilityBot(request);
 const {job}=await(await request.post('/api/cron/jobs',{data:{botId:bot.id,name:'health policy',prompt:'inspect',intervalMs:60000}})).json();
 ownedJobs.push(job.id);
 await page.goto('/#/tasks/runs');
 const card=page.getByTestId(`routine-health-${job.id}`);await expect(card).toBeVisible();
 await card.getByLabel('连续硬失败暂停阈值').fill('3');
 await card.getByRole('button',{name:'保存策略',exact:true}).click();
 await expect.poll(async()=>{const res=await request.get(`/api/cron/jobs/${job.id}/health`);return res.ok()?(await res.json()).health.policy.hardFailureThreshold:null;}).toBe(3);
 await page.reload();await expect(card.getByLabel('连续硬失败暂停阈值')).toHaveValue('3');
 await card.getByRole('button',{name:'恢复后续执行',exact:true}).click();
 await expect.poll(async()=>{const res=await request.get(`/api/cron/jobs/${job.id}/health`);return res.ok()?(await res.json()).health.resumeAfter:undefined;}).toBeTruthy();
});

test('failed deletion stays visible and can be retried [AC:memory-deletion-suppression#AC-8]',async({page,request})=>{
 await page.addInitScript(()=>localStorage.setItem('lab.locale','zh'));
 const key=`failed-delete-${Date.now()}`;
 await request.post('/api/memory',{data:{scope:'user.memory',namespace:'default',key,value:'用户喜欢茶'}});
 await page.goto('/#/knowledge/memory');await page.locator('#memorySearch').fill(key);
 const row=page.locator('#listMemory .list-item').filter({hasText:key});
 await page.route('**/api/memory/*',async route=>{if(route.request().method()==='DELETE')await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'suppression write failed'})});else await route.continue();});
 await row.getByRole('button',{name:'删除',exact:true}).click();await row.getByRole('button',{name:'确认删除',exact:true}).click();
 await expect(row).toBeVisible();await expect(page.getByText(/suppression write failed/).first()).toBeVisible();
 await expect(page.getByTestId('memory-suppressions').locator('article').filter({hasText:key})).toHaveCount(0);
});
