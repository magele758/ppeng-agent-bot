import { expect, test } from '@playwright/test';
const bots=[{id:'a',name:'Bot A'},{id:'b',name:'Bot B'},{id:'c',name:'Bot C'}];
test('private confirmation shows owner and explicit recipients [AC:bot-scoped-skill-sharing#AC-1] [AC:bot-scoped-skill-sharing#AC-3]',async({page})=>{
 const sid='scoped-capture-session';const session={id:sid,title:'scoped capture',mode:'chat',status:'idle',agentId:'general'};
 const capture={id:'sc_ui',name:'release-check',description:'Release',reason:'Success',summary:'Health checks',kind:'new',status:'pending',ownerBotId:'a',sharedBotIds:[]};
 await page.route('**/api/bots',r=>r.fulfill({json:{bots}}));
 await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[session]}}));
 await page.route(new RegExp(`/api/sessions/${sid}(?:\\?|$)`),r=>r.fulfill({json:{session,messages:[]}}));
 await page.route(`**/api/sessions/${sid}/skill-captures`,r=>r.fulfill({json:{captures:[capture]}}));
 let body:unknown;
 await page.route(`**/api/sessions/${sid}/skill-captures/sc_ui/confirm`,async r=>{body=r.request().postDataJSON();capture.status='saved';await r.fulfill({json:{capture}})});
 await page.goto('/#/chat');await page.getByRole('button',{name:/scoped capture/}).first().click();
 const card=page.getByRole('dialog',{name:'技能沉淀建议'});await expect(card).toContainText('Bot A');await expect(card).toContainText('仅所属 Bot 可用');await expect(card.getByLabel('Bot B',{exact:true})).not.toBeChecked();await card.getByLabel('Bot B',{exact:true}).check();await card.getByRole('button',{name:'确认并提炼'}).click();await expect.poll(()=>body).toEqual({sharedBotIds:['b']});
});
test('manage ownership, read-only sharing, revoke warning and restrictions [AC:bot-scoped-skill-sharing#AC-10] [AC:bot-scoped-skill-sharing#AC-6] [AC:bot-scoped-skill-sharing#AC-7] [AC:bot-scoped-skill-sharing#AC-11]',async({page})=>{
 let row={id:'sp_ui',name:'release-check',description:'Release',status:'approved',kind:'new',ownerBotId:'a',sharedBotIds:['b'],blockedBotIds:['b'],bodyPreview:'',bodyChars:1,sessionId:'s',createdAt:'2026-10-21T00:00:00Z'};
 await page.route('**/api/bots',r=>r.fulfill({json:{bots}}));await page.route('**/api/skill-proposals',r=>r.fulfill({json:{proposals:[row]}}));
 await page.route('**/api/skill-proposals/settings',r=>r.fulfill({json:{settings:{enabled:true,remindEveryNToolCalls:10},effective:{enabled:true,source:'ui'}}}));
 await page.route('**/api/skill-proposals/sp_ui/sharing',async r=>{row={...row,...r.request().postDataJSON()};await r.fulfill({json:{proposal:row}})});
 await page.goto('/#/agents/skills');const panel=page.getByTestId('bot-skill-manager');await panel.getByLabel('按 Bot 查看').selectOption('b');await expect(panel).toContainText('他人共享（只读）');await expect(panel).toContainText('已有技能使用限制');await expect(panel.getByRole('button',{name:'保存共享范围'})).toHaveCount(0);
 await panel.getByLabel('按 Bot 查看').selectOption('a');await expect(panel).toContainText('不会清除历史对话');await panel.getByLabel('Bot B',{exact:true}).uncheck();await panel.getByRole('button',{name:'保存共享范围'}).click();await expect.poll(()=>row.sharedBotIds).toEqual([]);
 let confirmation='';page.on('dialog',async d=>{confirmation=d.message();await d.dismiss()});await panel.getByRole('button',{name:'撤销',exact:true}).click();expect(confirmation).toContain('Bot A');expect(confirmation).toContain('后续无法加载');
});
