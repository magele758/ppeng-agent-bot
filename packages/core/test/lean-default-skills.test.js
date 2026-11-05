import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinSkills } from '../dist/skills/builtin-skills.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { resolveSkillSearch, resolveSkillLoad } from '../dist/runtime/skill-load.js';
import { writeSkillSettings } from '../dist/skills/skill-settings.js';

process.env.RAW_AGENT_AGENTS_SKILLS = '0';

function setup() {
 const own={id:'my-zebra',name:'Private Zebra',description:'private zebra workflow',content:'unchanged private body',source:'user',ownerBotId:'owner'};
 const external={id:'external-zebra',name:'External Zebra',description:'external zebra workflow',content:'external workflow body',source:'workspace'};
 const session={id:'lean',mode:'chat',todo:[],summary:'',metadata:{botId:'owner',skillScope:'full'}};
 const kv=new Map();
 const store={getDaemonControl:k=>kv.get(k),setDaemonControl:(k,v)=>kv.set(k,v),getSession:()=>session,listSessionMemory:()=>[]};
 writeSkillSettings(store,{disclosureMode:'shortlist',routingMode:'hybrid',topK:8,strictLoad:true});
 const pb=new PromptBuilder({repoRoot:'/nonexistent-lean-skills',store,extraSkills:[own,external]});
 const ctx={session,agent:{id:'general',name:'Test',role:'assistant',instructions:'',capabilities:[]},repoRoot:'/nonexistent-lean-skills'};
 const messages=[{id:'u',sessionId:'lean',role:'user',parts:[{type:'text',text:'plan tasks team parallel learn sprint zebra workflow'}],createdAt:new Date().toISOString()}];
 return {pb,ctx,messages,store,own,external,host:{promptBuilder:pb,emitTrace(){}}};
}

test('merged builtins retain old names and task tools [AC:lean-default-skills#AC-1]',async()=>{
 assert.equal(builtinSkills.length,4);
 const f=setup();
 writeSkillSettings(f.store,{disclosureMode:'full'});
 assert.match((await resolveSkillLoad(f.host,'Tasks','lean')).content,/blockedBy/);
 assert.match((await resolveSkillLoad(f.host,'Team','lean')).content,/mailbox/);
 const planning=builtinSkills.find(s=>s.id==='planning');
 assert.ok(planning.manifest.allowTools.includes('task_create'));
});

test('only merged shared defaults route; others search then load and full stays available [AC:lean-default-skills#AC-2]',async()=>{
 const f=setup();
 await f.pb.buildDynamicContext(f.ctx,f.messages);
 const names=f.pb.getRouting('lean').shortlistNames;
 assert.ok(!names.includes('Guided learning'));
 assert.ok(!names.includes('Long-running harness'));
 assert.ok(!names.includes('External Zebra'));
 for(const query of ['Guided learning','Long-running harness','External Zebra']) {
  const result=JSON.parse((await resolveSkillSearch(f.host,query,'lean',20)).content);
  const hit=result.hits.find(s=>s.name===query);
  assert.ok(hit,query);
  assert.ok((await resolveSkillLoad(f.host,hit.id,'lean')).content,query);
 }
 writeSkillSettings(f.store,{disclosureMode:'full'});
 const full=await f.pb.buildDynamicContext(f.ctx,f.messages);
 assert.ok(full.includes('External Zebra'));
 assert.ok(full.includes('Guided learning'));
});

test('own skill content and direct load survive default simplification [AC:lean-default-skills#AC-3]',async()=>{
 const f=setup();
 await f.pb.buildDynamicContext(f.ctx,f.messages);
 assert.ok(f.pb.getRouting('lean').shortlistNames.includes(f.own.name));
 assert.match((await resolveSkillLoad(f.host,f.own.id,'lean')).content,/unchanged private body/);
 assert.equal((await f.pb.skillsForSession('lean')).find(s=>s.id===f.own.id).content,f.own.content);
});

test('saved legacy selections and allowlists still resolve merged builtins [AC:lean-default-skills#AC-1]',async()=>{
 const f=setup();
 f.ctx.session.metadata.allowedSkills=['Tasks','Team'];
 f.store.setDaemonControl('bot_skill_selection:owner',{mode:'selected',ids:['tasks','team']});
 await f.pb.buildDynamicContext(f.ctx,f.messages);
 const names=(await f.pb.skillsForSession('lean')).map(s=>s.name);
 assert.deepEqual(names.sort(),['Planning','Subagents']);
 const result=JSON.parse((await resolveSkillSearch(f.host,'tasks team','lean',20)).content);
 assert.ok(result.hits.some(s=>s.name==='Planning'));
 assert.ok((await resolveSkillLoad(f.host,'Tasks','lean')).content);
});

test('explicitly enabled external skills remain eligible for routing [AC:lean-default-skills#AC-1]',async()=>{
 const f=setup();
 f.ctx.session.metadata.allowedSkills=[f.external.name];
 await f.pb.buildDynamicContext(f.ctx,f.messages);
 assert.ok(f.pb.getRouting('lean').shortlistNames.includes(f.external.name));
});
