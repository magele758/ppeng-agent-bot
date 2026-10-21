import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page) {
  const sessions = ['a','b'].map(id => ({ id: `op-${id}`, title: `Operation ${id}`, mode:'chat', status:'idle', agentId:'general' }));
  const operations = ['create','update','share','unshare','set_sharing','delete'].map(action => ({ id:action, name:action, affectedBotIds:[], input:{action, reason:'详细理由'.repeat(100),summary:'x'.repeat(1000)}, status:'saved', error:undefined as string|undefined }));
  for(const status of ['pending','processing','rejected','failed']) operations.push({...operations[0], id:status,name:status,status,error:status==='failed'?'Failure detail '.repeat(100):undefined});
  const captures = ['saved','rejected','failed'].map(status=>({id:status,name:`capture-${status}`,kind:'new',description:'Description',reason:'reason',summary:'summary',status,error:status==='failed'?'Capture failure '.repeat(100):undefined}));
  let polls=0; const writes:string[]=[];
  page.on('request',r=>{if(['POST','PATCH','DELETE'].includes(r.method()) && /skill|memory/.test(r.url())) writes.push(r.url());});
  await page.route('**/api/sessions',r=>r.fulfill({json:{sessions}}));
  for(const session of sessions){
    await page.route(new RegExp(`/api/sessions/${session.id}(?:\\?|$)`),r=>r.fulfill({json:{session,messages:[{id:'text',role:'assistant',parts:[{type:'text',text:'正文保留'}]}]}}));
    await page.route(`**/api/sessions/${session.id}/skill-operations`,r=>{polls++;return r.fulfill({json:{operations}});});
    await page.route(`**/api/sessions/${session.id}/skill-captures`,r=>r.fulfill({json:{captures}}));
  }
  await page.goto('/#/chat');await page.getByRole('button',{name:/Operation a/}).first().click();
  return {operations,polls:()=>polls,writes};
}
const card=(page:Page,id:string)=>page.getByRole('dialog',{name:'技能管理建议'}).filter({has:page.getByRole('heading',{name:new RegExp(' · '+id+'$')})});
test('completed operations compact and close without mutation [AC:skill-operation-card-dismissal#AC-1] [AC:skill-operation-card-dismissal#AC-2] [AC:skill-operation-card-dismissal#AC-4]',async({page})=>{
 const {writes}=await setup(page);
 for(const id of ['create','update','share','unshare','set_sharing','delete']){
  const row=card(page,id);await expect(row.getByRole('status')).toHaveText('已完成');
  await expect(row.getByText('详细理由'.repeat(100),{exact:true})).not.toBeVisible();
  await row.getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(row.getByText('详细理由'.repeat(100),{exact:true})).toBeVisible();
  await row.getByRole('button',{name:'收起详情',exact:true}).click();
  await row.getByRole('button',{name:'关闭提示',exact:true}).click();await expect(row).toHaveCount(0);
 }
 await expect(card(page,'pending').getByRole('button',{name:'确认并执行'})).toBeVisible();
 await expect(card(page,'processing').getByRole('status')).toBeVisible();
 await expect(card(page,'failed').getByRole('alert')).toBeVisible();expect(writes).toEqual([]);
});
test('dismissal persists and isolates sessions and new results [AC:skill-operation-card-dismissal#AC-3]',async({page})=>{
 const {operations,polls}=await setup(page);
 await card(page,'create').getByRole('button',{name:'关闭提示',exact:true}).click();
 const before=polls();await expect.poll(polls).toBeGreaterThan(before);await expect(card(page,'create')).toHaveCount(0);
 operations.push({...operations[0],id:'new',name:'new'});await expect(card(page,'new')).toBeVisible();
 await page.reload();await page.getByRole('button',{name:/Operation a/}).first().click();await expect(card(page,'new')).toBeVisible();await expect(card(page,'create')).toHaveCount(0);
 await page.getByRole('button',{name:/Operation b/}).first().click();await expect(card(page,'create')).toBeVisible();
 await page.getByRole('button',{name:/Operation a/}).first().click();await expect(card(page,'new')).toBeVisible();await expect(card(page,'create')).toHaveCount(0);
});
test('rejected capture and operation can close persistently [AC:skill-operation-card-dismissal#AC-7]',async({page})=>{
 const {writes}=await setup(page);
 for(const row of [card(page,'rejected'),page.getByTestId('skill-capture-rejected')]){
 await expect(row.getByRole('status')).toContainText('拒绝');await expect(row.getByRole('button',{name:'查看详情',exact:true})).toBeVisible();
 await row.getByRole('button',{name:'关闭提示',exact:true}).click();await expect(row).toHaveCount(0);
 }
 await page.reload();await page.getByRole('button',{name:/Operation a/}).first().click();await expect(card(page,'pending')).toBeVisible();
 await expect(card(page,'rejected')).toHaveCount(0);await expect(page.getByTestId('skill-capture-rejected')).toHaveCount(0);expect(writes).toEqual([]);
});
test('failed details collapse without losing failure status [AC:skill-operation-card-dismissal#AC-8]',async({page})=>{
 await setup(page);
 for(const row of [card(page,'failed'),page.getByTestId('skill-capture-failed')]){
 await expect(row.getByRole('alert')).toBeVisible();await row.getByRole('button',{name:'收起详情',exact:true}).click();
 await expect(row.getByRole('alert')).not.toBeVisible();await expect(row.getByRole('status')).toContainText('失败');
 await expect(row.getByRole('button',{name:'关闭提示',exact:true})).toHaveCount(0);
 await row.getByRole('button',{name:'查看详情',exact:true}).click();await expect(row.getByRole('alert')).toBeVisible();
 }
});
for(const width of [1280,820]) test(`keyboard dismissal leaves usable conversation at ${width} [AC:skill-operation-card-dismissal#AC-5] [AC:skill-operation-card-dismissal#AC-6]`,async({page})=>{
 await page.setViewportSize({width,height:804});await setup(page);
 await page.getByTestId('skill-capture-saved').getByRole('button',{name:'关闭已保存提示'}).click();
 const row=card(page,'create');await row.getByRole('button',{name:'查看详情',exact:true}).focus();await page.keyboard.press('Enter');
 expect(await row.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await row.getByRole('button',{name:'收起详情',exact:true}).click();await row.getByRole('button',{name:'关闭提示',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(row).toHaveCount(0);await expect(card(page,'update')).toBeInViewport();await expect(page.locator('#playInput')).toBeInViewport();
 await page.locator('#playInput').fill('继续');await expect(page.locator('#playInput')).toHaveValue('继续');
 await page.reload();await page.getByRole('button',{name:/Operation a/}).first().click();await expect(card(page,'update')).toBeVisible();await expect(row).toHaveCount(0);await expect(page.getByTestId('skill-capture-saved')).toHaveCount(0);
 await expect(page.getByText('正文保留',{exact:true})).toBeVisible();
});
