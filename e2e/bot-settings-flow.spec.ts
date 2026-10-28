import {test,expect} from '@playwright/test';
import {allocateBot} from './helpers/bot-first-task';

test('Bot basics save, fail and report effect without losing input [AC:bot-settings-flow#AC-4] [AC:bot-settings-flow#AC-7]',async({page,request})=>{
 const {bot,release}=await allocateBot(request);
 let fail=false;
 await page.route(`**/api/bots/${bot.id}`,r=>fail&&r.request().method()==='PATCH'?r.fulfill({status:503,json:{error:'Save unavailable'}}):r.continue());
 try {
  await page.goto('/#/agents/bots');await page.getByTestId(`bot-card-${bot.id}`).click();
  const panel=page.getByTestId('bot-detail');
  await panel.getByLabel('Bot 名称',{exact:true}).fill('Updated '+bot.id);
  await panel.getByLabel('用途与说明',{exact:true}).fill('Run verification');
  await panel.getByRole('button',{name:'保存基本资料',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  await expect(page.getByTestId(`bot-card-${bot.id}`)).toContainText('Updated '+bot.id);
  fail=true;
  await panel.getByLabel('用途与说明',{exact:true}).fill('Keep my draft',{timeout:10000});
  await panel.getByRole('button',{name:'保存基本资料',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('Save unavailable');
  await expect(panel.getByLabel('用途与说明',{exact:true})).toHaveValue('Keep my draft');
 }finally{await release().catch(()=>{});}
});

test('skill and sharing drafts survive settings tabs [AC:bot-settings-flow#AC-3] [AC:bot-settings-flow#AC-6]',async({page,request})=>{
 const {bot,release}=await allocateBot(request);
 try{
  await page.route('**/api/bots',r=>r.fulfill({json:{bots:[bot,{id:'share-target',name:'Share target',agentId:'general'}]}}));
  await page.route(`**/api/bots/${bot.id}/skills`,r=>r.fulfill({json:{policy:{mode:'all',ids:[]},revision:'r1',operations:[],skills:[{id:'own',name:'check',description:'check',canManage:true,enabled:true,ownerBotId:bot.id,sharedBotIds:[],revision:'s1'}]}}));
  await page.goto('/#/agents/bots');await page.getByTestId(`bot-card-${bot.id}`).click();
  const panel=page.getByTestId('bot-detail');
  await panel.getByRole('tab',{name:'能力与权限',exact:true}).click();
  const skills=panel.getByTestId('bot-detail-skills');
  await skills.getByLabel('技能使用范围').selectOption('selected');
  await skills.getByLabel('Share target',{exact:true}).check();
  await panel.getByRole('tab',{name:'基本设置',exact:true}).click();
  await panel.getByRole('tab',{name:'能力与权限',exact:true}).click();
  await expect(skills.getByLabel('技能使用范围')).toHaveValue('selected');
  await expect(skills.getByLabel('Share target',{exact:true})).toBeChecked();
  await expect(skills).toContainText('尚未保存');
  await expect(panel.getByLabel('Bot 允许的技能')).toHaveCount(0);
  await expect(panel.getByTestId('bot-connection-wizard')).not.toBeVisible();
 }finally{await release().catch(()=>{});}
});

test('create Bot opens its conversation with optional appearance collapsed [AC:bot-settings-flow#AC-5]',async({page,request})=>{
 const name='Create flow '+crypto.randomUUID();
 try{
  await page.goto('/#/agents/bots');await page.getByTestId('bot-create-open').click();
  await expect(page.getByTestId('bot-create-title')).not.toBeVisible();
  await page.getByTestId('bot-create-name').fill(name);
  await page.getByTestId('bot-create-description').fill('Test assistant');
  await page.getByTestId('bot-create-submit').click();
  await expect(page).toHaveURL(/#\/(bot|chat)/);
  await expect(page.locator('#playTitle')).toContainText(name);
  await page.getByTestId('bot-detail-toggle').click();
  await expect(page.getByTestId('bot-detail-panel').getByLabel('Bot 名称',{exact:true})).toHaveValue(name);
 }finally{
  const {bots}=await(await request.get('/api/bots')).json();
  const bot=bots.find((b:{name:string})=>b.name===name);if(bot)await request.patch(`/api/bots/${bot.id}`,{data:{hidden:true}});
 }
});

test('global panel saves routing and live capabilities with honest status [AC:bot-settings-flow#AC-8] [AC:bot-settings-flow#AC-9] [AC:bot-settings-flow#AC-7]',async({page,request})=>{
 const priorSkills=(await(await request.get('/api/skills/settings')).json()).effective;
 const priorCapabilities=(await(await request.get('/api/runtime-capabilities')).json()).settings;
 try {
  await page.goto('/#/settings/tools');
  const skills=page.locator('#card-skill-disclosure');
  await skills.getByLabel('技能路由模式',{exact:true}).selectOption('lexical');
  await expect(skills.getByRole('status')).toContainText('下一执行步骤');
  await skills.getByLabel('候选技能数量',{exact:true}).fill('3');
  await skills.getByRole('button',{name:'保存',exact:true}).click();
  await expect(skills.getByRole('status')).toContainText('下一执行步骤');
  await skills.getByLabel('仅允许加载本轮候选或已搜索的技能').check();
  await expect(skills.getByRole('status')).toContainText('已保存');
  await skills.getByLabel('融合关联技能').check();
  await expect(skills.getByRole('status')).toContainText('已保存');
  const caps=page.locator('#card-runtime-capabilities');
  await caps.getByLabel('允许 Bot 渲染交互卡片').check();
  await expect(caps.getByRole('status')).toContainText('下一执行步骤');
  const data=await(await request.get('/api/runtime-capabilities')).json();
  const domain=data.availableDomains[0];
  await caps.getByLabel(domain.label,{exact:true}).check();
  await expect(caps.getByRole('status')).toContainText('已保存');
  await page.reload();
  await expect(skills.getByLabel('技能路由模式',{exact:true})).toHaveValue('lexical');
  await expect(skills.getByLabel('候选技能数量',{exact:true})).toHaveValue('3');
  await expect(skills.getByLabel('仅允许加载本轮候选或已搜索的技能')).toBeChecked();
  await expect(skills.getByLabel('融合关联技能')).toBeChecked();
  await expect(caps.getByLabel('允许 Bot 渲染交互卡片')).toBeChecked();
  await expect(caps.getByLabel(domain.label,{exact:true})).toBeChecked();
  const tools=(await(await request.get('/api/tools')).json()).tools;
  expect(tools.some((t:{name:string})=>t.name==='a2ui_render')).toBe(true);
  await caps.getByLabel('允许 Bot 渲染交互卡片').uncheck();
  await expect(caps.getByRole('status')).toContainText('已保存');
  expect((await(await request.get('/api/tools')).json()).tools.some((t:{name:string})=>t.name==='a2ui_render')).toBe(false);
 }finally{
  await request.patch('/api/skills/settings',{data:priorSkills});
  await request.patch('/api/runtime-capabilities',{data:priorCapabilities});
 }
});
