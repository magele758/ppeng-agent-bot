import test from 'node:test';
import assert from 'node:assert/strict';
import {PromptBuilder} from '../dist/model/prompt-builder.js';
import {resolveSkillLoad,resolveSkillSearch} from '../dist/runtime/skill-load.js';
import {writeSkillSettings} from '../dist/skills/skill-settings.js';

function fixture(mode='shortlist',metadata={botId:'owner',skillScope:'full'}) {
 const kv=new Map();
 const store={getDaemonControl:k=>kv.get(k),setDaemonControl:(k,v)=>kv.set(k,v),getSession:id=>({id,metadata}),listSessionMemory:()=>[]};
 writeSkillSettings(store,{disclosureMode:mode,routingMode:'hybrid',strictLoad:true,topK:1});
 const skill={id:'bot-local-zebra',name:'zebra-local-check',description:'zebra unique local verification',content:'# Zebra saved procedure',source:'user',ownerBotId:'owner'};
 const shared={id:'shared-otter',name:'otter-shared-check',description:'otter unique shared verification',content:'# Otter shared procedure',source:'workspace'};
 const pb=new PromptBuilder({repoRoot:'/nonexistent-skill-recovery',store,extraSkills:[skill,shared]});
 pb.getRouting=()=>({shortlistNames:['Planning'],routed:[],confidence:{level:'low'}});
 return {pb,store,skill,shared,host:{promptBuilder:pb,emitTrace(){}}};
}

test('自建技能越过推荐名单但不需要搜索 [AC:skill-load-recovery#AC-1]',async()=>{
 for(const mode of ['shortlist','lazy']){
  const f=fixture(mode);
  for(const key of [f.skill.name,f.skill.id]) assert.match((await resolveSkillLoad(f.host,key,'s1')).content??'',/Zebra saved procedure/);
 }
});

test('搜索到的其他技能可加载且仅作用于当前会话 [AC:skill-load-recovery#AC-2]',async()=>{
 for(const mode of ['shortlist','lazy']){
  const f=fixture(mode);
  assert.ok((await resolveSkillLoad(f.host,f.shared.id,'s1')).error);
  const result=JSON.parse((await resolveSkillSearch(f.host,'otter unique shared verification','s1',20)).content);
  assert.ok(result.hits.some(h=>h.id===f.shared.id));
  assert.match((await resolveSkillLoad(f.host,f.shared.id,'s1')).content??'',/Otter shared procedure/);
  assert.ok((await resolveSkillLoad(f.host,f.shared.id,'s2')).error);
 }
});

test('自建及搜索都不能绕过归属和允许名单 [AC:skill-load-recovery#AC-3]',async()=>{
 const foreign=fixture('shortlist',{botId:'other',skillScope:'full'});
 assert.ok((await resolveSkillLoad(foreign.host,foreign.skill.id,'s')).error);
 const blocked=fixture('shortlist',{botId:'owner',skillScope:'full',allowedSkills:['Planning']});
 assert.ok((await resolveSkillLoad(blocked.host,blocked.skill.id,'s')).error);
 const hits=JSON.parse((await resolveSkillSearch(blocked.host,'zebra local','s')).content).hits;
 assert.ok(!hits.some(h=>h.id===blocked.skill.id));
 const disabled=fixture();
 await resolveSkillSearch(disabled.host,'zebra local','s');
 disabled.store.setDaemonControl('bot_skill_selection:owner',{mode:'selected',ids:[]});
 assert.ok((await resolveSkillLoad(disabled.host,disabled.skill.id,'s')).error);
});
