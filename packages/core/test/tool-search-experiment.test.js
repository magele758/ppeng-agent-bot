import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSearchTools } from '../dist/tools/tool-search.js';
import { readToolExposure, writeToolExposure, toolDirectory } from '../dist/tools/tool-exposure.js';
const tool = (name, description = name) => ({name,description,inputSchema:{type:'object',properties:{}},execute:async()=>{throw Error('search must not execute')}});
function fixture(catalog = [tool('quote_get','Get the latest stock quote for a symbol.')]) {
 const data=new Map(); const store={getDaemonControl:k=>structuredClone(data.get(k)),setDaemonControl:(k,v)=>data.set(k,structuredClone(v))};
 const session={id:'test',agentId:'general',mode:'chat',metadata:{}};
 const agent={id:'general'}; const calls=[];
 const services={settingsStore:store,env:{},getCatalog:()=>catalog,isEnabled:()=>false,discloseTool:(_id,name)=>{calls.push(name);session.metadata.disclosedToolNames=[...(session.metadata.disclosedToolNames??[]),name]}};
 const [search]=createToolSearchTools(services);
 return {store,session,agent,calls,services,catalog,run:async(query,extra={})=>JSON.parse((await search.execute({session,agent},{query,...extra})).content)};
}
test('strategy defaults, persists and validates atomically [AC:tool-search-experiment#AC-1]',async()=>{
 const h=fixture(); assert.equal(readToolExposure(h.store).searchStrategy,'legacy');
 writeToolExposure(h.store,{searchStrategy:'enhanced'});
 assert.equal(readToolExposure(h.store).searchStrategy,'enhanced');
 assert.throws(()=>writeToolExposure(h.store,{mode:'full',searchStrategy:'bad'}));
 assert.equal(readToolExposure(h.store).mode,'progressive');
 assert.equal((await h.run('查股价')).loaded[0],'quote_get');
 writeToolExposure(h.store,{searchStrategy:'legacy'});
 assert.equal((await h.run('查股价')).status,'no_match');
});
test('bilingual intent, exact ranking and bounded non-executing load [AC:tool-search-experiment#AC-2]',async()=>{
 for(const query of ['帮我查一下苹果现在的股价','stock price','quote_get','+quote_get']) {
  const h=fixture();writeToolExposure(h.store,{searchStrategy:'enhanced'});
  const r=await h.run(query);assert.equal(r.hits[0]?.name,'quote_get',query);assert.deepEqual(r.loaded,['quote_get']);
 }
 const h=fixture([...Array.from({length:7},(_,i)=>tool(`extension_${i}`,'quote_get stock price')),tool('quote_get')]);
 writeToolExposure(h.store,{searchStrategy:'enhanced'});
 const r=await h.run('quote_get');assert.equal(r.hits[0].name,'quote_get');assert.equal(r.loaded.length,5);
});
test('loaded tools stay searchable and restrictions never leak [AC:tool-search-experiment#AC-3]',async()=>{
 const h=fixture([tool('quote_get'),tool('k8s_get'),tool('lcu_js')]);writeToolExposure(h.store,{searchStrategy:'enhanced'});
 await h.run('quote_get');const r=await h.run('quote_get');assert.equal(r.hits[0].state,'already_loaded');assert.deepEqual(r.loaded,[]);assert.equal(h.calls.length,1);
 h.agent.allowedTools=['quote_get'];assert.equal((await h.run('k8s_get')).hits.length,0);
 const empty=await h.run('nonexistent');assert.deepEqual(empty.groups.map(g=>g.id),['stock']);
 h.services.discloseTool=()=>{throw Error('storage unavailable')};h.session.metadata={};
 const failed=await h.run('quote_get');assert.equal(failed.status,'load_failed');assert.equal(failed.hits[0].state,'load_failed');assert.deepEqual(failed.loaded,[]);
});
test('no-match returns authorized browse groups; browse pages do not overlap [AC:tool-search-experiment#AC-4]',async()=>{
 const h=fixture(Array.from({length:8},(_,i)=>tool(`ext_${i}`)));writeToolExposure(h.store,{searchStrategy:'enhanced'});
 const r=await h.run('does not exist');assert.equal(r.status,'no_match');assert.deepEqual(r.loaded,[]);assert.equal(r.groups[0].id,'extensions');assert.match(r.guidance,/group/);
 const a=await h.run('',{group:'extensions'});const b=await h.run('',{group:'extensions',offset:a.nextOffset});
 assert.equal(a.hits.length,5);assert.equal(b.hits.length,3);assert.equal(new Set([...a.hits,...b.hits].map(t=>t.name)).size,8);
 assert.equal(b.nextOffset,null);assert.equal((await h.run('',{group:'unknown'})).hits.length,0);
});
test('enhanced guidance and observations support the experiment [AC:tool-search-experiment#AC-6]',async()=>{
 const h=fixture();writeToolExposure(h.store,{searchStrategy:'enhanced'});
 assert.match(toolDirectory(h.store),/already_loaded/);
 const r=await h.run('stock price');assert.equal(r.strategy,'enhanced');assert.equal(r.candidateCount,1);assert.equal(r.matchedCount,1);
 writeToolExposure(h.store,{mode:'full'});assert.doesNotMatch(toolDirectory(h.store),/already_loaded/);
});

test('enhanced search loads a tool into the next runtime turn and executes once [AC:tool-search-experiment#AC-6]',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {RawAgentRuntime}=await import('../dist/runtime.js');
 const dir=mkdtempSync(join(tmpdir(),'search-experiment-'));let turns=0,calls=0;
 const adapter={name:'search-experiment',runTurn:async input=>{
  turns++;const names=input.tools.map(t=>t.name);
  if(turns===1){assert.ok(!names.includes('quote_get'));return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'search',name:'tool_search',input:{query:'帮我查一下苹果现在的股价'}}]};}
  if(turns===2){assert.ok(names.includes('quote_get'));return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'quote',name:'quote_get',input:{}}]};}
  return {stopReason:'end',assistantParts:[{type:'text',text:'done'}]};
 }};
 const rt=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:adapter,extraTools:[{...tool('quote_get','Get the latest stock quote for a symbol.'),approvalMode:'never',sideEffectLevel:'none',execute:async()=>{calls++;return {ok:true,content:'quote observed'}}}]});
 t.after(async()=>{await rt.destroy();rmSync(dir,{recursive:true,force:true})});
 writeToolExposure(rt.store,{searchStrategy:'enhanced'});
 const session=rt.store.createSession({agentId:'general',mode:'chat',title:'enhanced',background:false});
 rt.sendUserMessage(session.id,'查苹果股价');await rt.runSession(session.id);
 assert.equal(turns,3);assert.equal(calls,1);
});

test('fractional limits cannot produce a stuck empty browse page [AC:tool-search-experiment#AC-4]',async()=>{
 const h=fixture([tool('ext_a'),tool('ext_b')]);writeToolExposure(h.store,{searchStrategy:'enhanced'});
 const r=await h.run('',{group:'extensions',limit:0.5});assert.equal(r.hits.length,1);assert.equal(r.nextOffset,1);
});
