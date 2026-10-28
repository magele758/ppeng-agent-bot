import test from 'node:test';
import assert from 'node:assert/strict';
import { skillProposalRoutes } from '../dist/routes/skill-proposals.js';
import { runtimeCapabilitiesRoutes } from '../dist/routes/runtime-capabilities.js';
import { readBotSkillSelection, readRuntimeCapabilities, registerDomainCatalog } from '@ppeng/agent-core';

test('unified skill policy preserves legacy limits until explicitly saved and checks revision [AC:bot-settings-flow#AC-2]',async()=>{
 const values=new Map<string,unknown>();
 const sessions=[{id:'s',metadata:{botId:'bot',canonicalBotChat:true,allowedSkills:['alpha']}},{id:'s2',metadata:{botId:'bot',canonicalBotChat:true,allowedSkills:['alpha']}},{id:'child',metadata:{botId:'bot',allowedSkills:['alpha']}}];
 const skills=[{id:'a',name:'alpha',revision:'1',sharedBotIds:[]},{id:'b',name:'beta',revision:'1',sharedBotIds:[]}];
 const store={getBot:()=>({canonicalSessionId:'s'}),getSession:(id:string)=>sessions.find(s=>s.id===id),updateSession:(id:string,patch:object)=>Object.assign(sessions.find(s=>s.id===id)!,patch),getDaemonControl:(key:string)=>values.get(key),setDaemonControl:(key:string,value:unknown)=>values.set(key,value)};
 const runtime={store,listSessions:()=>sessions,skillManagement:{catalog:async()=>skills,listForBot:()=>[]},skillCaptures:{list:()=>[]},promptBuilder:{skillsForSession:async()=>skills,getAllowedSkills:(id:string)=>store.getSession(id)?.metadata.allowedSkills}};
 const routes=skillProposalRoutes(runtime as never);
 const get=routes.find(r=>r.method==='GET'&&r.pattern==='/api/bots/:id/skills')!;
 const patch=routes.find(r=>r.method==='PATCH'&&r.pattern==='/api/bots/:id/skills')!;
 let body:any;const ctx={requireParam:()=> 'bot',response:{setHeader(){},end(text:string){body=JSON.parse(text);}}};
 await get.handler(ctx as never);
 assert.deepEqual(body.policy,{mode:'selected',ids:['a']});
 assert.deepEqual(sessions[0].metadata.allowedSkills,['alpha']);
 const old=body.revision;
 await assert.rejects(patch.handler({...ctx,readBody:async()=>{sessions[0].metadata.allowedSkills=['beta'];return {revision:old,policy:{mode:'all',ids:[]}};}} as never),/refresh/);
 sessions[0].metadata.allowedSkills=['beta'];
 await assert.rejects(patch.handler({...ctx,readBody:async()=>({revision:old,policy:{mode:'all',ids:[]}})} as never),/refresh/);
 await get.handler(ctx as never);
 await patch.handler({...ctx,readBody:async()=>({revision:body.revision,policy:{mode:'all',ids:[]}})} as never);
 assert.deepEqual(readBotSkillSelection(store,'bot'),{mode:'all',ids:[]});
 assert.deepEqual(sessions[0].metadata.allowedSkills,[]);assert.deepEqual(sessions[1].metadata.allowedSkills,[]);
 assert.deepEqual(sessions[2].metadata.allowedSkills,['alpha']);
});

test('capability panel persists enable/disable and rejects unknown domains [AC:bot-settings-flow#AC-9]',async()=>{
 const values=new Map<string,unknown>();const store={getDaemonControl:(key:string)=>values.get(key),setDaemonControl:(key:string,value:unknown)=>values.set(key,value)};
 registerDomainCatalog(store,[{id:'stock',label:'Stock',agents:[],tools:[]}]);
 const routes=runtimeCapabilitiesRoutes({store} as never);let body:any;
 const response={setHeader(){},end(text:string){body=JSON.parse(text);}};
 const patch=routes.find(r=>r.method==='PATCH')!;
 await patch.handler({response,readBody:async()=>({domains:['stock'],a2uiEnabled:true})} as never);
 assert.deepEqual(body.settings,{domains:['stock'],a2uiEnabled:true});assert.equal(body.effective.applyAt,'next-step');
 await assert.rejects(patch.handler({response,readBody:async()=>({domains:['missing']})} as never),/Unknown domain/);
 assert.deepEqual(readRuntimeCapabilities(store),{domains:['stock'],a2uiEnabled:true});
});
