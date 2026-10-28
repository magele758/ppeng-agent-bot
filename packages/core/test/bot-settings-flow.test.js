import test from 'node:test';
import assert from 'node:assert/strict';
import * as skillSettings from '../dist/skills/skill-settings.js';
import { authorizeToolsForSession } from '../dist/turn/resolve-turn-tools.js';

function store() {
  const kv = new Map();
  return { getDaemonControl: key => kv.get(key), setDaemonControl: (key, value) => kv.set(key, value) };
}
test('saved skill routing overrides env per field and rejects invalid values [AC:bot-settings-flow#AC-8]', () => {
  const db = store();
  const env = {RAW_AGENT_SKILL_ROUTING_MODE:'lexical', RAW_AGENT_SKILL_ROUTING_TOP_K:'12', RAW_AGENT_SKILL_LOAD_STRICT:'1'};
  assert.equal(typeof skillSettings.resolveSkillRoutingSettings, 'function');
  assert.equal(skillSettings.resolveSkillRoutingSettings({store:db,env}).routingMode, 'lexical');
  skillSettings.writeSkillSettings(db, {disclosureMode:'lazy'});
  assert.equal(skillSettings.resolveSkillRoutingSettings({store:db,env}).topK, 12);
  skillSettings.writeSkillSettings(db, {routingMode:'hybrid',topK:3,strictLoad:false,fusion:true});
  assert.deepEqual(skillSettings.resolveSkillRoutingSettings({store:db,env}), {routingMode:'hybrid',topK:3,strictLoad:false,fusion:true});
  for (const patch of [{topK:0},{topK:1.5},{topK:51},{routingMode:'bad'},{strictLoad:'true'},{fusion:1}]) {
    assert.throws(()=>skillSettings.writeSkillSettings(db,patch));
    assert.equal(skillSettings.resolveSkillRoutingSettings({store:db,env}).topK,3);
  }
});

test('disabled interactive cards cannot enter the exposed tool set [AC:bot-settings-flow#AC-9]', () => {
  const db=store(); db.setDaemonControl('runtime_capabilities',{a2uiEnabled:false,domains:[]});
  const tool={name:'a2ui_render',description:'Card',inputSchema:{type:'object'},execute:async()=>({ok:true,content:''})};
  const session={id:'s',agentId:'a',mode:'chat',metadata:{}};
  const agent={id:'a',name:'a',role:'a',instructions:'',capabilities:[]};
  const result=authorizeToolsForSession({env:{RAW_AGENT_A2UI_ENABLED:'1'},tools:[tool],agent,session,settingsStore:db});
  assert.deepEqual(result.tools.map(t=>t.name),[]);
});

import { RawAgentRuntime } from '../dist/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('running Bot changes tools on the next step in both kernels [AC:bot-settings-flow#AC-1]', async (t) => {
for (const kernelVariant of ['agent-loop','ppeng']) await t.test(kernelVariant, async () => {
  const root=mkdtempSync(join(tmpdir(),'bot-settings-flow-'));
  let rt,bot,turn=0; const seen=[];
  const adapter={name:'review-test',async summarizeMessages(){return '';},async runTurn(input){
    seen.push(input.tools.map(t=>t.name)); turn++;
    if(turn===1)rt.updateBot(bot.id,{allowedTools:['read_file','write_file']});
    if(turn===2)rt.updateBot(bot.id,{allowedTools:['write_file']});
    return {stopReason:turn<3?'tool_use':'end',assistantParts:turn<3?[{type:'tool_call',id:`call-${turn}`,name:turn===1?'read_file':'write_file',arguments:turn===1?{path:'missing-review-file'}:{path:'result.txt',content:'ok'}}]:[{type:'text',text:'Done'}]};
  }};
  try {
    rt=new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:adapter});
    rt.store.setDaemonControl('loop_settings',{kernelVariant,assemblyPreset:'normal'});
    bot=rt.createBot({name:'Live policy'});
    rt.updateBot(bot.id,{allowedTools:['read_file'],maxTurns:24});
    rt.mergeSessionMetadata(bot.canonicalSessionId,{permissionMode:'auto'});
    rt.store.appendMessage(bot.canonicalSessionId,'user',[{type:'text',text:'Run checks'}]);
    await rt.runSession(bot.canonicalSessionId);
    assert.ok(seen.length>=3,JSON.stringify(seen));
    assert.ok(seen[1].includes('write_file'),JSON.stringify(seen));
    assert.ok(!seen[2].includes('read_file'),JSON.stringify(seen));
  } finally {await rt?.destroy();}
});
});

import { writeRuntimeCapabilities } from '../dist/config/runtime-capabilities.js';
import { resolveSkillLoad, resolveSkillSearch } from '../dist/runtime/skill-load.js';
import { resolveEffectiveConfig } from '../dist/config/effective-config.js';

test('capabilities toggle on the same runtime including dispatch and skills [AC:bot-settings-flow#AC-9]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capabilities-live-'));
  let calls = 0;
  const bundle = {
    id: 'test-domain', label: 'Test',
    agents: [{id:'domain-agent',name:'Domain',role:'assistant',instructions:'',capabilities:[]}],
    tools: [{name:'domain_check',description:'Check',inputSchema:{type:'object'},execute:async()=>{calls++;return {ok:true,content:'ok'};}}],
    skills: [{id:'domain-skill',name:'Domain skill',description:'Test skill',content:'Test content',source:'workspace'}]
  };
  const rt = new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),domainBundles:[bundle],modelAdapter:{name:'test'}});
  try {
    writeRuntimeCapabilities(rt.store,{domains:[],a2uiEnabled:false});
    const savedTool = rt.tools.find(tool=>tool.name==='domain_check');
    assert.equal((await savedTool.execute({},{})).ok,false);
    assert.equal(calls,0);
    const peer = new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),modelAdapter:{name:'peer'}});
    try {
      assert.equal((await savedTool.execute({},{})).ok,false,'a peer must not erase this runtime domain ownership');
      assert.ok(!rt.availableTools().some(tool=>tool.name==='domain_check'));
      assert.ok(!(await rt.promptBuilder.skillsForSession('test')).some(skill=>skill.id==='domain-skill'));
    } finally { await peer.destroy(); }
    writeRuntimeCapabilities(rt.store,{domains:['test-domain'],a2uiEnabled:true});
    assert.ok(rt.availableTools().some(tool=>tool.name==='a2ui_render'));
    assert.ok(rt.availableTools().some(tool=>tool.name==='domain_check'));
    assert.ok(rt.listAgents().some(agent=>agent.id==='domain-agent'));
    assert.ok((await rt.promptBuilder.skillsForSession('test')).some(skill=>skill.id==='domain-skill'));
    assert.equal((await savedTool.execute({},{})).ok,true);
    assert.equal(calls,1);
    writeRuntimeCapabilities(rt.store,{domains:[],a2uiEnabled:false});
    assert.ok(!rt.availableTools().some(tool=>tool.name==='domain_check'||tool.name==='a2ui_render'));
    assert.ok(!rt.listAgents().some(agent=>agent.id==='domain-agent'));
    assert.ok(!(await rt.promptBuilder.skillsForSession('test')).some(skill=>skill.id==='domain-skill'));
    assert.equal((await savedTool.execute({},{})).ok,false);
    assert.equal((await rt.tools.find(tool=>tool.name==='a2ui_render').execute({},{})).ok,false);
    assert.equal(calls,1);
    const actual = resolveEffectiveConfig({env:{RAW_AGENT_A2UI_ENABLED:'1',RAW_AGENT_DOMAINS:'test-domain'},lab:{runtimeCapabilities:{domains:[],a2uiEnabled:false}},runtime:{domainsMounted:[]}});
    const items = actual.items;
    for(const id of ['manual.a2ui','capability.domains']) {
      assert.equal(items.find(item=>item.id===id).enabled,false);
      assert.equal(items.find(item=>item.id===id).source,'lab');
    }
  } finally {await rt.destroy();}
});

test('saved routing is used by search and strict load without rebuilding the runtime [AC:bot-settings-flow#AC-8]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-live-'));
  const skills = Array.from({length:4},(_,i)=>({id:`xy-skill-${i}`,name:`xy-skill-${i}`,description:'xy-special zebra check',content:`Body ${i}`,source:'workspace'}));
  const rt = new RawAgentRuntime({repoRoot:root,stateDir:join(root,'state'),extraSkills:skills,modelAdapter:{name:'test'}});
  const host={promptBuilder:rt.promptBuilder,emitTrace(){}};
  try {
    skillSettings.writeSkillSettings(rt.store,{disclosureMode:'lazy',routingMode:'lexical',topK:1,strictLoad:true,fusion:false});
    assert.match((await resolveSkillLoad(host,'xy-skill-0','s')).error,/search_skills/);
    const first=JSON.parse((await resolveSkillSearch(host,'xy-special zebra','s')).content);
    assert.equal(first.hits.length,1);
    assert.ok((await resolveSkillLoad(host,first.hits[0].id,'s')).content);
    const excluded=skills.find(skill=>skill.id!==first.hits[0].id);
    assert.ok((await resolveSkillLoad(host,excluded.id,'s')).error);
    skillSettings.writeSkillSettings(rt.store,{topK:3,strictLoad:false,routingMode:'lexical',fusion:true});
    assert.ok((await resolveSkillLoad(host,excluded.id,'s')).content);
    assert.equal(JSON.parse((await resolveSkillSearch(host,'xy-special zebra','s')).content).hits.length,3);
  } finally {await rt.destroy();}
});
