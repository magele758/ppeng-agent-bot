import {test,expect,type Page} from '@playwright/test';
const provider={id:'model-probe-provider',name:'Probe Provider',kind:'openai-compatible',baseUrl:'https://models.invalid/v1',hasApiKey:true,apiKeyMasked:'••••',useJsonMode:false,models:[{id:'enabled-first',enabled:true},{id:'enabled-second',enabled:true},{id:'disabled-model',enabled:false}],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',source:'ui'};
async function mockCatalog(page:Page,empty=false){
 let selected={providerId:provider.id,modelId:'enabled-first'};let fail=true;
 const payload=()=>({catalog:{providers:empty?[]:[provider],defaultRef:empty?null:selected,updatedAt:'2026-01-01T00:00:00Z'},options:empty?[]:provider.models.filter(m=>m.enabled).map(m=>({providerId:provider.id,providerName:provider.name,modelId:m.id,kind:provider.kind,source:'ui'})),persisted:true,effective:{source:empty?'heuristic':'ui',defaultRef:empty?{providerId:'__heuristic__',modelId:'heuristic'}:selected}});
 await page.route(/\/api\/model-providers(?:\?.*)?$/,r=>r.fulfill({json:payload()}));
 await page.route('**/api/model-providers/default',r=>{
  if(fail){fail=false;return r.fulfill({status:503,json:{error:'Save unavailable'}});}
  selected=r.request().postDataJSON().defaultRef;return r.fulfill({json:payload()});
 });
 return {selected:()=>selected};
}

test('global default selector uses existing enabled models, preserves saved value after failure, and persists successful choice [AC:global-default-model-clarity#AC-1] [AC:global-default-model-clarity#AC-6]',async({page})=>{
 const state=await mockCatalog(page);await page.goto('/#/settings/models');
 const select=page.getByLabel('全局默认模型',{exact:true});
 await expect(select).toHaveValue(`${provider.id}::enabled-first`);
 await expect(select.locator('option')).toHaveCount(2);await expect(select.locator('option',{hasText:'disabled-model'})).toHaveCount(0);
 await expect(page.locator('.model-default-row')).toContainText('Probe Provider');
 await select.selectOption(`${provider.id}::enabled-second`);
 await expect(page.getByRole('alert').filter({hasText:'保存全局默认模型失败'})).toBeVisible();
 expect(state.selected().modelId).toBe('enabled-first');await expect(select).toHaveValue(`${provider.id}::enabled-first`);
 await select.selectOption(`${provider.id}::enabled-second`);await expect(select).toHaveValue(`${provider.id}::enabled-second`);
 await page.reload();await expect(select).toHaveValue(`${provider.id}::enabled-second`);
});

test('no real configured model is clearly shown with setup guidance [AC:global-default-model-clarity#AC-5]',async({page})=>{
 await mockCatalog(page,true);await page.goto('/#/settings/models');
 const select=page.getByLabel('全局默认模型',{exact:true});await expect(select).toBeDisabled();
 await expect(page.locator('#card-model-providers')).toContainText('尚未配置可用模型');
 await expect(page.locator('#card-model-providers').getByRole('button',{name:'配置模型',exact:true})).toBeVisible();
});

type Box={x:number;y:number;width:number;height:number};
function midY(box:Box){return box.y+box.height/2;}
function linesOf(items:Box[]){
 const sorted=[...items].sort((a,b)=>a.y-b.y||a.x-b.x);
 const groups:Box[][]=[];
 for(const item of sorted){
  const last=groups.at(-1);
  if(!last||item.y>=last[0].y+last[0].height-2) groups.push([item]);
  else last.push(item);
 }
 return groups;
}
async function defaultRowBoxes(page:Page){
 await expect(page.getByLabel('全局默认模型',{exact:true})).toBeVisible();
 return page.evaluate(()=>{
  const body=document.querySelector('#card-model-providers .ui-group__body');
  const row=document.querySelector('.model-default-row');
  const label=row?.querySelector('label');
  const select=row?.querySelector('select');
  const note=row?.querySelector(':scope > .muted');
  const box=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  if(!body||!row||!label||!select) return null;
  return {body:box(body),label:box(label),select:box(select),note:note?box(note):null};
 });
}

test('global default title, menu, and provider note share one centered row [AC:global-default-model-row-align#AC-1]',async({page})=>{
 await mockCatalog(page);
 await page.setViewportSize({width:1440,height:900});
 await page.goto('/#/settings/models');
 const boxes=await defaultRowBoxes(page);
 expect(boxes?.note).toBeTruthy();
 const {body,label,select,note}=boxes!;
 expect(Math.abs(midY(label)-midY(select))).toBeLessThanOrEqual(2);
 expect(Math.abs(midY(note!)-midY(select))).toBeLessThanOrEqual(2);
 expect(note!.y).toBeGreaterThanOrEqual(select.y-2);
 expect(note!.y+note!.height).toBeLessThanOrEqual(select.y+select.height+2);
 expect(Math.abs(label.x-body.x)).toBeLessThanOrEqual(1);
 expect(note!.x).toBeGreaterThanOrEqual(select.x+select.width-1);
 expect(note!.x+note!.width).toBeLessThanOrEqual(body.x+body.width+1);
 expect(select.x+select.width).toBeLessThanOrEqual(body.x+body.width+1);
});

test('narrow global default row wraps without shifting its left edge [AC:global-default-model-row-align#AC-2]',async({page})=>{
 await mockCatalog(page);
 await page.setViewportSize({width:480,height:900});
 await page.goto('/#/settings/models');
 const boxes=await defaultRowBoxes(page);
 expect(boxes?.note).toBeTruthy();
 const {body,label,select,note}=boxes!;
 const items=[label,select,note!];
 expect(Math.max(...items.map(item=>item.y))).toBeGreaterThan(label.y+label.height);
 for(const line of linesOf(items)){
  expect(Math.abs(Math.min(...line.map(item=>item.x))-body.x)).toBeLessThanOrEqual(1);
  for(const item of line){
   expect(item.x).toBeGreaterThanOrEqual(body.x-1);
   expect(item.x+item.width).toBeLessThanOrEqual(body.x+body.width+1);
  }
 }
});

test('empty global default row stays centered on the card edge [AC:global-default-model-row-align#AC-3]',async({page})=>{
 await mockCatalog(page,true);
 await page.setViewportSize({width:1440,height:900});
 await page.goto('/#/settings/models');
 const boxes=await defaultRowBoxes(page);
 expect(boxes).toBeTruthy();
 expect(boxes!.note).toBeNull();
 const {body,label,select}=boxes!;
 expect(Math.abs(midY(label)-midY(select))).toBeLessThanOrEqual(2);
 expect(label.y).toBeGreaterThanOrEqual(select.y-2);
 expect(label.y+label.height).toBeLessThanOrEqual(select.y+select.height+2);
 expect(Math.abs(label.x-body.x)).toBeLessThanOrEqual(1);
 expect(select.x+select.width).toBeLessThanOrEqual(body.x+body.width+1);
});
