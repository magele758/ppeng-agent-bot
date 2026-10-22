import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/runtime.js';
import {listArtifactManifests,readPagedArtifactPage} from '../dist/artifact/index.js';

async function runOutput({content,disabled=false,readback=false,middleMarker=undefined}){
 const directory=mkdtempSync(join(tmpdir(),'assembled-artifact-')),repoRoot=join(directory,'repo'),stateDir=join(directory,'state');mkdirSync(repoRoot);let rt,turn=0,observed,handle,readPage;
 const tool={name:'integration_output',description:'Return deterministic test data',inputSchema:{type:'object',properties:{}},approvalMode:'never',sideEffectLevel:'none',async execute(){return {ok:true,content};}};
 const modelAdapter={name:'artifact-integration',contextWindow:131072,async runTurn(input){
  if(turn++===0)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:tool.name,toolCallId:'initial_output',input:{}}]};
  const result=input.messages.flatMap(message=>message.parts).find(part=>part.type==='tool_result'&&part.toolCallId==='initial_output');assert.ok(result);observed=result.content;
  if(readback&&turn===2){handle=String(observed).match(/Artifact Handle:\s*`([^`]+)`/)?.[1];assert.ok(handle,'the model sees a real core artifact handle');assert.ok(input.tools.some(tool=>tool.name==='read_artifact_page'));if(middleMarker)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:'search_artifact_content',toolCallId:'search_middle',input:{handle,query:middleMarker}}]};return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:'read_artifact_page',toolCallId:'read_back',input:{handle,page:1,maxChars:2000}}]};}
  if(middleMarker&&turn===3){const search=input.messages.flatMap(message=>message.parts).find(part=>part.type==='tool_result'&&part.toolCallId==='search_middle');assert.equal(search?.ok,true);const hits=JSON.parse(search.content);assert.ok(hits.matches?.length>0);assert.ok(hits.matches[0].startOffset>120000,'the stored archive retains bytes beyond the SDK truncation limit');return {stopReason:'tool_use',assistantParts:[{type:'tool_call',name:'read_artifact_page',toolCallId:'read_back',input:{handle,startOffset:Math.max(0,hits.matches[0].startOffset-100),maxChars:2000}}]};}
  if(readback){const page=input.messages.flatMap(message=>message.parts).find(part=>part.type==='tool_result'&&part.toolCallId==='read_back');assert.equal(page?.ok,true);readPage=JSON.parse(page.content);assert.equal(readPage.success,true);if(middleMarker)assert.ok(readPage.content.includes(middleMarker));else assert.ok(readPage.content.startsWith('ARCHIVE_ORIGINAL_HEAD'));}
  return {stopReason:'end',assistantParts:[{type:'text',text:'Verified tool result'}]};
 },async summarizeMessages(){return 'Test summary';}};
 try{rt=new RawAgentRuntime({repoRoot,stateDir,modelAdapter,extraTools:[tool]});rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});rt.store.setDaemonControl('loop_settings',{kernelVariant:'agent-loop',assemblyPreset:'max'});if(disabled)rt.store.setDaemonControl('ingestion_settings',{enabled:false});const session=rt.createChatSession({agentId:'general',message:'Run the test output tool'});await rt.runSession(session.id);
  const actual=rt.getSession(session.id);assert.equal(actual.metadata?.outcome?.kind,'idle');assert.equal(actual.metadata?.outcome?.reason,'end');const manifests=listArtifactManifests(stateDir,session.id);
  if(readback){assert.equal(manifests.length,1);assert.equal(manifests[0].handle,handle);assert.equal(readPagedArtifactPage({stateDir,sessionId:session.id,handle,page:1}).content.slice(0,21),content.slice(0,21));assert.ok(String(observed).length<5000);assert.ok(!String(observed).includes('Handle: `'+content));assert.ok(readPage);}
  else {const stored=rt.store.listHistory(session.id,{limit:20}).messages.flatMap(message=>message.parts).find(part=>part.type==='tool_result'&&part.toolCallId==='initial_output');assert.equal(stored?.content===content,true,'the persisted tool result is original content');if(!disabled)assert.equal(observed===content,true,'8KiB model payload must not inflate or become a fake handle');else assert.ok(!String(observed).includes('Artifact Handle:')&&!String(observed).includes('[Tool result archived'));assert.equal(manifests.length,0);}
 }finally{await rt?.destroy();rmSync(directory,{recursive:true,force:true});}
}
test('max assembled runtime keeps an 8KiB software result intact instead of preview-as-handle inflation',()=>runOutput({content:'EIGHT_KIB_HEAD'.padEnd(8192,'x')}));
test('max assembled runtime archives >80k output and model reads the actual artifact handle',()=>runOutput({content:'ARCHIVE_ORIGINAL_HEAD'.padEnd(90000,'x'),readback:true}));
test('max assembled runtime respects disabled ingestion and keeps >80k output inline',()=>runOutput({content:'DISABLED_ARCHIVE_HEAD'.padEnd(90000,'x'),disabled:true}));

test('max assembled runtime preserves >120k archive tail and model searches then reads a middle marker',()=>runOutput({content:'ARCHIVE_ORIGINAL_HEAD'.padEnd(150000,'x')+'\nARCHIVE_MIDDLE_UNIQUE_141\n'+'y'.repeat(100000),readback:true,middleMarker:'ARCHIVE_MIDDLE_UNIQUE_141'}));
