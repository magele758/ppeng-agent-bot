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
