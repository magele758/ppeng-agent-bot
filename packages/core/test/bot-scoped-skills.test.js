import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillCaptureService, SkillProposalStore } from '../dist/skill-proposals/index.js';
import { loadStateDirSkills, mergeSkillsByName } from '../dist/skills/builtin-skills.js';
import { resolveSkillLoad, resolveSkillSearch } from '../dist/runtime/skill-load.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
const intent={name:'release-check',description:'release verification',reason:'Release succeeded',summary:'Check build and health'};
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'bot-skills-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bots=['a','b','c']; const store=new SkillProposalStore(dir);
 const deps={stateDir:dir,settingsStore:{getDaemonControl:()=>({enabled:true})},listSkills:()=>loadStateDirSkills(dir),getEvidence:()=> 'success',complete:async()=>JSON.stringify({description:'release verification',body:'# Check health'}),reloadSkills:async()=>{},getBotId:s=>s.split(':')[0],validateSharing:(owner,ids)=>{if(!bots.includes(owner)||ids.some(id=>!bots.includes(id)))throw Error('Unknown Bot');}};
 const service=new SkillCaptureService(deps);
 const visible=async bot=>(await loadStateDirSkills(dir)).filter(s=>!s.ownerBotId||s.ownerBotId===bot||s.sharedBotIds?.includes(bot));
 const save=async(bot,shared=[])=>{const c=await service.suggest(bot+':1',bot,intent);return service.confirm(bot+':1',c.id,{sharedBotIds:shared});};
 return {dir,store,deps,service,visible,save};
}
test('private capture belongs to Bot across sessions [AC:bot-scoped-skill-sharing#AC-1] [AC:bot-scoped-skill-sharing#AC-2]',async t=>{
 const x=setup(t);const c=await x.service.suggest('a:1','agent',intent);assert.equal(c.ownerBotId,'a');assert.deepEqual(c.sharedBotIds,[]);
 const s=await x.service.confirm('a:1',c.id);assert.equal(s.status,'saved',s.error);assert.equal((await x.visible('a')).length,1);assert.equal((await x.visible('b')).length,0);
});
test('explicit sharing and restart preserve membership [AC:bot-scoped-skill-sharing#AC-3] [AC:bot-scoped-skill-sharing#AC-13]',async t=>{
 const x=setup(t);const s=await x.save('a',['b']);assert.equal(s.status,'saved',s.error);const fresh=new SkillProposalStore(x.dir);assert.deepEqual(fresh.get(s.proposalId).sharedBotIds,['b']);assert.equal((await x.visible('b'))[0].ownerBotId,'a');assert.equal((await x.visible('c')).length,0);assert.equal((await x.visible('new-bot')).length,0);
});
test('shared recipients cannot update origin, may propose private copy [AC:bot-scoped-skill-sharing#AC-4]',async t=>{
 const x=setup(t);await x.save('a',['b']);const own=await x.service.suggest('b:1','agent',intent);assert.equal(own.kind,'new');assert.equal(own.ownerBotId,'b');assert.equal((await x.visible('b'))[0].ownerBotId,'a');
 await assert.rejects(x.service.suggest('b:2','agent',{...intent,targetSkillId:(await x.visible('b'))[0].id}),/read.only|own/i);
});
test('owner updates shared content without resetting recipients [AC:bot-scoped-skill-sharing#AC-5]',async t=>{
 const x=setup(t);await x.save('a',['b']);x.deps.complete=async()=>JSON.stringify({description:'release',body:'# Updated checks'});const c=await x.service.suggest('a:2','agent',{...intent,summary:'Update checks'});assert.equal(c.kind,'update');const s=await x.service.confirm('a:2',c.id);assert.equal(s.status,'saved',s.error);assert.equal((await x.visible('b'))[0].ownerBotId,'a');assert.deepEqual((await x.visible('b'))[0].sharedBotIds,['b']);assert.match((await x.visible('b'))[0].content,/Updated/);
});
test('unshare and revoke affect only chosen identities [AC:bot-scoped-skill-sharing#AC-6] [AC:bot-scoped-skill-sharing#AC-7]',async t=>{
 const x=setup(t);const s=await x.save('a',['b','c']);x.store.setSharing(s.proposalId,'a',['c'],x.deps.validateSharing);assert.equal((await x.visible('b')).length,0);assert.equal((await x.visible('c')).length,1);x.store.revoke(s.proposalId);assert.equal((await x.visible('a')).length,0);assert.equal((await x.visible('c')).length,0);
});
test('same names are independent and survive catalog merge [AC:bot-scoped-skill-sharing#AC-8]',async t=>{
 const x=setup(t);const a=await x.save('a');const b=await x.save('b');assert.equal(b.status,'saved',b.error);assert.notEqual(x.store.get(a.proposalId).installedPath,x.store.get(b.proposalId).installedPath);assert.equal(mergeSkillsByName([],await loadStateDirSkills(x.dir)).length,2);x.store.revoke(a.proposalId);assert.equal((await x.visible('b')).length,1);
});
test('invalid recipients and failed sharing leave original state [AC:bot-scoped-skill-sharing#AC-12]',async t=>{
 const x=setup(t);const s=await x.save('a',['b']);const path=join(x.dir,x.store.get(s.proposalId).installedPath);const before=readFileSync(path,'utf8');assert.throws(()=>x.store.setSharing(s.proposalId,'a',['missing'],x.deps.validateSharing),/Unknown/);assert.equal(readFileSync(path,'utf8'),before);
 x.store.write=()=>{throw Error('disk full')};assert.throws(()=>x.store.setSharing(s.proposalId,'a',['c'],x.deps.validateSharing),/disk full/);assert.equal(readFileSync(path,'utf8'),before);
});
test('legacy sharing retained until explicit ownership conversion [AC:bot-scoped-skill-sharing#AC-14]',async t=>{
 const x=setup(t);const legacy=x.store.create({...intent,body:'# Legacy',sessionId:'old'});x.store.approve(legacy.id);assert.equal((await x.visible('c')).length,1);x.store.setSharing(legacy.id,'a',['b'],x.deps.validateSharing);assert.equal((await x.visible('c')).length,0);assert.equal((await x.visible('b')).length,1);
});
function host(x,bot,allowedSkills){
 const pb=new PromptBuilder({repoRoot:join(x.dir,'repo'),stateDir:x.dir,store:{getSession:()=>({id:bot,metadata:{botId:bot,allowedSkills,skillScope:'full'}})}});
 return {promptBuilder:pb,emitTrace(){}};
}
test('runtime disambiguates visible names and refuses private IDs [AC:bot-scoped-skill-sharing#AC-9] [AC:bot-scoped-skill-sharing#AC-2]',async t=>{
 const x=setup(t);await x.save('a',['b']);await x.save('b');const a=(await x.visible('a'))[0];
 const stranger=host(x,'c');assert.match((await resolveSkillLoad(stranger,a.id,'c')).error,/not found/);
 assert.equal(JSON.parse((await resolveSkillSearch(stranger,'release-check','c')).content).hits.some(h=>h.name==='release-check'),false);
 const b=host(x,'b');const hits=JSON.parse((await resolveSkillSearch(b,'release-check','b')).content).hits.filter(h=>h.name==='release-check');assert.equal(hits.length,2);assert.deepEqual(new Set(hits.map(h=>h.ownerBotId)),new Set(['a','b']));
 assert.match((await resolveSkillLoad(b,'release-check','b')).error,/ambiguous/i);for(const h of hits)assert.match((await resolveSkillLoad(b,h.id,'b')).content,/health/);
});
test('sharing cannot bypass the receiving allowlist [AC:bot-scoped-skill-sharing#AC-11]',async t=>{
 const x=setup(t);await x.save('a',['b']);const b=host(x,'b',['unrelated']);assert.equal(JSON.parse((await resolveSkillSearch(b,'release-check','b')).content).hits.some(h=>h.name==='release-check'),false);assert.ok((await resolveSkillLoad(b,(await x.visible('b'))[0].id,'b')).error);
});

test('real Bot tool and management routes preserve isolation and reload after unsharing [AC:bot-scoped-skill-sharing#AC-2] [AC:bot-scoped-skill-sharing#AC-6] [AC:bot-scoped-skill-sharing#AC-11] [AC:bot-scoped-skill-sharing#AC-12]',async t=>{
 const {RawAgentRuntime}=await import('../dist/runtime.js');const {writeSkillProposalSettings}=await import('../dist/skill-proposals/index.js');const {skillProposalRoutes}=await import('../../../apps/daemon/dist/routes/skill-proposals.js');
 const dir=mkdtempSync(join(tmpdir(),'bot-skills-runtime-'));
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'scoped-test',runTurn:async()=>({assistantParts:[],stopReason:'end'}),summarizeMessages:async()=>'',completeText:async()=>JSON.stringify({description:'release checks',body:'# Verified health'})}});
 t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true})});writeSkillProposalSettings(runtime.store,{enabled:true});
 const a=runtime.createBot({name:'Owner'}),b=runtime.createBot({name:'Reader'}),c=runtime.createBot({name:'Stranger'});
 const session=runtime.store.getSession(a.canonicalSessionId);const tool=runtime.tools.find(t=>t.name==='skill_propose');const proposed=await tool.execute({session,agent:{id:a.agentId}},intent);assert.equal(proposed.ok,true,proposed.content);const capture=JSON.parse(proposed.content).capture;assert.equal(capture.ownerBotId,a.id);
 const saved=await runtime.skillCaptures.confirm(session.id,capture.id,{sharedBotIds:[b.id]});assert.equal(saved.status,'saved',saved.error);
 const strangerSession=runtime.store.getSession(c.canonicalSessionId);
 const prompt=await runtime.promptBuilder.buildDynamicContext({session:strangerSession,agent:{id:c.agentId,name:'Stranger',role:'assistant',instructions:'Help',capabilities:[]},repoRoot:dir},[{role:'user',parts:[{type:'text',text:'release-check health'}]}]);
 assert.doesNotMatch(prompt,/release-check|Verified health/);
 const h={promptBuilder:runtime.promptBuilder,emitTrace(){}};assert.match((await resolveSkillLoad(h,intent.name,b.canonicalSessionId)).content,/Verified/);assert.ok((await resolveSkillLoad(h,intent.name,c.canonicalSessionId)).error);
 async function route(method,pattern,body={}){let result;await skillProposalRoutes(runtime).find(r=>r.method===method&&r.pattern===pattern).handler({requireParam:()=>saved.proposalId,readBody:async()=>body,url:new URL('http://local'),response:{setHeader(){},end(s){result=JSON.parse(s)}}});return result;}
 await assert.rejects(route('PATCH','/api/skill-proposals/:id/sharing',{ownerBotId:a.id,sharedBotIds:['missing']}),/Unknown Bot/);
 assert.match((await resolveSkillLoad(h,intent.name,b.canonicalSessionId)).content,/Verified/);
 runtime.mergeSessionMetadata(b.canonicalSessionId,{allowedSkills:['unrelated']});const list=await route('GET','/api/skill-proposals');assert.deepEqual(list.proposals[0].blockedBotIds,[b.id]);assert.ok((await resolveSkillLoad(h,intent.name,b.canonicalSessionId)).error);
 runtime.mergeSessionMetadata(b.canonicalSessionId,{allowedSkills:[]});
 await route('PATCH','/api/skill-proposals/:id/sharing',{ownerBotId:a.id,sharedBotIds:[]});assert.ok((await resolveSkillLoad(h,intent.name,b.canonicalSessionId)).error);assert.equal(JSON.parse((await resolveSkillSearch(h,intent.name,b.canonicalSessionId)).content).hits.some(s=>s.name===intent.name),false);assert.match((await resolveSkillLoad(h,intent.name,a.canonicalSessionId)).content,/Verified/);
});

test('old pending capture displays and saves a private scope without modifying legacy skill [AC:bot-scoped-skill-sharing#AC-14]',async t=>{
 const x=setup(t);const legacy=x.store.create({...intent,body:'# Shared original',sessionId:'legacy'});x.store.approve(legacy.id);
 const oldService=new SkillCaptureService({...x.deps,getBotId:undefined});const pending=await oldService.suggest('a:old','agent',intent);assert.equal(pending.kind,'update');
 const displayed=x.service.list('a:old')[0];assert.equal(displayed.ownerBotId,'a');assert.equal(displayed.kind,'new');assert.deepEqual(displayed.sharedBotIds,[]);
 const saved=await x.service.confirm('a:old',pending.id);assert.equal(saved.status,'saved',saved.error);assert.match((await x.visible('b'))[0].content,/Shared original/);assert.equal((await x.visible('a')).length,2);
});
