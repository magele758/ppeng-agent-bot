import test from 'node:test';
import assert from 'node:assert/strict';
import { skillProposalRoutes } from '../dist/routes/skill-proposals.js';
import { readBotSkillSelection } from '@ppeng/agent-core';

test('Bot skill selection persists valid choices and rejects stale or foreign IDs [AC:bot-detail-skill-management#AC-3]', async () => {
 const values=new Map<string,unknown>();
 const skills=[{id:'owned',name:'owned',revision:'v1',sharedBotIds:[]}];
 const store={getBot:(id:string)=>id==='bot'?{canonicalSessionId:'s'}:undefined,getDaemonControl:(key:string)=>values.get(key),setDaemonControl:(key:string,value:unknown)=>values.set(key,value)};
 const runtime={store,listSessions:()=>[],skillManagement:{catalog:async()=>skills,listForBot:()=>[]},promptBuilder:{skillsForSession:async()=>skills,getAllowedSkills:()=>undefined}};
 const routes=skillProposalRoutes(runtime as never);
 const get=routes.find(r=>r.method==='GET'&&r.pattern==='/api/bots/:id/skills')!;
 const patch=routes.find(r=>r.method==='PATCH'&&r.pattern==='/api/bots/:id/skills')!;
 let responseBody:{revision:string;policy:{mode:string;ids:string[]}};
 const context={requireParam:()=> 'bot',response:{setHeader(){},end(text:string){responseBody=JSON.parse(text);}}};
 await get.handler(context as never);
 const initial=responseBody!.revision;
 const save=async(body:unknown)=>patch.handler({...context,readBody:async()=>body} as never);
 await save({revision:initial,policy:{mode:'selected',ids:['owned','owned']}});
 assert.deepEqual(readBotSkillSelection(store,'bot'),{mode:'selected',ids:['owned']});
 const revision=responseBody!.revision;
 await assert.rejects(save({revision:initial,policy:{mode:'all',ids:[]}}),/refresh/);
 for(const policy of [null,{mode:'bad',ids:[]},{mode:'selected',ids:'owned'},{mode:'selected',ids:['foreign']},{mode:'selected',ids:[42]}]) {
  await assert.rejects(save({revision,policy}),/Invalid skill selection/);
  assert.deepEqual(readBotSkillSelection(store,'bot'),{mode:'selected',ids:['owned']});
 }
 await save({revision,policy:{mode:'all',ids:['owned']}});
 assert.deepEqual(readBotSkillSelection(store,'bot'),{mode:'all',ids:[]});
});
