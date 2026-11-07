import {test,expect} from '@playwright/test';

test('browser exceptions are reported and a render failure offers recovery [AC:lab-poll-crash-diagnostics#AC-3] [AC:lab-poll-crash-diagnostics#AC-4]',async({page})=>{
 const logs:Record<string,unknown>[]=[];
 const bot={id:'diagnostics-bot',name:'Diagnostics Bot',agentId:'general',canonicalSessionId:'diagnostics-session',hidden:false};
 const session={id:bot.canonicalSessionId,title:bot.name,status:'idle',mode:'chat',agentId:'general',metadata:{botId:bot.id,canonicalBotChat:true}};
 await page.addInitScript(()=>localStorage.setItem('lab.selectedBot','diagnostics-bot'));
 await page.route('**/api/user/preferences',r=>r.fulfill({json:{scope:'diagnostic-test',values:{'lab.locale':'zh'}}}));
 await page.route('**/api/bots',r=>r.fulfill({json:{bots:[bot]}}));
 await page.route(url=>url.pathname==='/api/sessions',r=>r.fulfill({json:{sessions:[session]}}));
 await page.route('**/api/bot-work/default',r=>r.fulfill({json:{bot}}));
 await page.route('**/api/bots/diagnostics-bot',r=>r.fulfill({json:{bot}}));
 await page.route('**/api/bots/diagnostics-bot/open',r=>r.fulfill({json:{bot,session}}));
 await page.route(url=>url.pathname==='/api/sessions/diagnostics-session',r=>r.fulfill({json:{session,messages:[],hasMore:false}}));

 await page.route('**/api/client-errors',async route=>{logs.push(route.request().postDataJSON());await route.fulfill({status:202,json:{ok:true}});});
 const list=page.waitForRequest(r=>new URL(r.url()).searchParams.get('view')==='summary');
 await page.goto('/#/bot');
 await list;
 await expect(page.locator('#playTitle')).toHaveText(bot.name);
 await page.waitForTimeout(500);
 await page.evaluate(()=>{
  setTimeout(()=>{throw new Error('diagnostic-runtime-probe');},0);
  void Promise.reject(new Error('diagnostic-promise-probe'));
 });
 await expect.poll(()=>logs.some(x=>x.kind==='error' && String(x.message).includes('diagnostic-runtime-probe'))).toBe(true);
 await expect.poll(()=>logs.some(x=>x.kind==='unhandledrejection')).toBe(true);
 expect(logs[0].sessionId).toBe(session.id);
 expect(logs[0].buildId).toBeTruthy();
 expect(logs[0].buildId).toBe(await page.locator('html').getAttribute('data-build-id')); expect(logs[0].stack).toBeTruthy();
 // An invalid React child in a real list response exercises the mounted boundary.
 await page.route('**/api/bots',r=>r.fulfill({json:{bots:[{id:'invalid-probe',name:{invalid:'react child'},canonicalSessionId:'s',hidden:false}]}}));
 await expect(page.getByRole('alert').filter({hasText:'页面遇到异常'})).toBeVisible({timeout:20000});
 await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeVisible();
 await expect.poll(()=>logs.some(x=>x.kind==='react' && !!x.componentStack)).toBe(true);
});
