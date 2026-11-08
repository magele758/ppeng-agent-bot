import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { resolveSkillLoad } from '../dist/runtime/skill-load.js';
function setup(){
 let active=true;
 const sessions=Object.fromEntries(['b','c'].map(id=>[id,{id,metadata:{botId:id},agentId:id,mode:'chat'}]));
 const store={getSession:id=>sessions[id],getDaemonControl:()=>undefined};
 const builder=new PromptBuilder({store,repoRoot:'/nonexistent',sharedSkills:id=>active&&id==='b'?[{id:'shared:release',name:'release',description:'release verification',content:'verified release steps',source:'user'}]:[],sharedMemory:(id)=>active&&id==='b'?'Release requires a health check.':''});
 builder.allSkills=async()=>[];
 return {builder,sessions,revoke:()=>{active=false;}};
}
test('shared skills are visible only to recipients and revocation bypasses warm cache [AC:bot-daydream-integration#AC-1]',async()=>{
 const x=setup();assert.equal((await x.builder.skillsForSession('b')).length,1);assert.equal((await x.builder.skillsForSession('c')).length,0);
 x.builder.getSkillRoutingSettings=()=>({strictLoad:false,routingMode:'legacy'});
 const host={promptBuilder:x.builder,emitTrace(){}};
 assert.match((await resolveSkillLoad(host,'shared:release','b')).content,/verified release/);
 x.revoke();assert.equal((await x.builder.skillsForSession('b')).length,0);assert.ok((await resolveSkillLoad(host,'shared:release','b')).error);
});
test('shared memory follows authorization and revocation [AC:bot-daydream-integration#AC-2]',()=>{
 const x=setup();assert.match(x.builder.buildMemoryAppendix({session:x.sessions.b},{query:'release'}),/health check/);assert.doesNotMatch(x.builder.buildMemoryAppendix({session:x.sessions.c},{query:'release'}),/health check/);x.revoke();assert.doesNotMatch(x.builder.buildMemoryAppendix({session:x.sessions.b},{query:'release'}),/health check/);
});
import { readBotDaydreamEvidence } from '../dist/runtime/daydream-evidence.js';
import { SqliteStateStore } from '../dist/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBotDefinitionOwner } from '../dist/bots/bot-identity.js';
test('daily evidence includes own multiple sessions and excludes other owners and dates [AC:bot-daydream-integration#AC-3]',t=>{
 const dir=mkdtempSync(join(tmpdir(),'daydream-evidence-'));const store=new SqliteStateStore(join(dir,'state.db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const sessions = ['u', 'u', 'other'].map(userId => store.createSession({
   title: 'chat', mode: 'chat', agentId: 'general', metadata: { botId: 'a', userId }
 }));
 store.getBot = () => ({id:'a', canonicalSessionId:sessions[0].id});
 setBotDefinitionOwner(store,'a',{userId:'u'});
 store.listMessages=id=>[{id:id+'m',role:'user',parts:[{type:'text',text:'project fact'}],createdAt:'2026-11-02T23:00:00Z'},{id:id+'old',role:'user',parts:[],createdAt:'2026-10-01T00:00:00Z'}];
 assert.deepEqual(readBotDaydreamEvidence(store,'a','2026-11-03','Asia/Shanghai').map(m=>m.messageId).sort(),sessions.slice(0,2).map(s=>s.id+'m').sort());
});
