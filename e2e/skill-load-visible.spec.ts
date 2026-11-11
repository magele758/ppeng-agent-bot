import {test,expect} from '@playwright/test';

test('loaded skill identity stays visible in brief chat without opening its body [AC:skill-load-visible#AC-1] [AC:skill-load-visible#AC-3]',async({page})=>{
 const id='skill-name-visibility';
 const session={id,title:id,mode:'chat',status:'idle',agentId:'general',metadata:{}};
 const parts=(role:string,id:string,seq:number,parts:object[])=>({id,seq,role,parts});
 const messages=[
  parts('user','u',1,[{type:'text',text:'查看技能'}]),
  parts('assistant','c',2,[{type:'tool_call',toolCallId:'skill',name:'load_skill',input:{name:'agent-home-diagnostics'}}]),
  parts('tool','r',3,[{type:'tool_result',toolCallId:'skill',name:'load_skill',ok:true,content:'SKILL_BODY_MARKER_DO_NOT_EXPAND'}]),
  parts('assistant','b',4,[{type:'tool_call',toolCallId:'shell',name:'bash',input:{command:'pwd'}}]),
  parts('tool','br',5,[{type:'tool_result',toolCallId:'shell',name:'bash',ok:true,content:'/workspace'}]),
  parts('assistant','a',6,[{type:'text',text:'已读完技能。'}])
 ];
 await page.route(url=>url.pathname==='/api/sessions',r=>r.fulfill({json:{sessions:[session]}}));
 await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`),r=>r.fulfill({json:{session,messages,hasMore:false,nextCursor:null}}));
 await page.goto('/#/chat');
 await page.getByRole('button',{name:/skill-name-visibility/}).first().click();
 const feed=page.locator('#playMessages');
 const label=feed.locator('.chat-tool-fold__name',{hasText:'加载技能：agent-home-diagnostics'});
 await expect(label).toBeVisible();
 await expect(feed.getByText('SKILL_BODY_MARKER_DO_NOT_EXPAND',{exact:true})).toBeHidden();
 await expect(feed.locator('.chat-tool-fold__name',{hasText:'bash'})).toHaveCount(0);
});
