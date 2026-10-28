import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/runtime.js';
import {BotGoalService} from '../dist/bots/goals/service.js';
import {BotStatusRequests} from '../dist/bots/bot-status-requests.js';

test('real Bot tool loop produces one correlated fresh status reply without creating work [AC:bot-supervision-freshness#AC-1] [AC:bot-supervision-freshness#AC-3] [AC:bot-supervision-freshness#AC-4]',{timeout:30000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'supervision-kernel-'));let runtime,worker,requestId,checks=0;
 const adapter={name:'controlled-supervision',async runTurn(input){
  const id=runtime.store.getSession(input.sessionId).metadata.botId;
  if(id!==worker?.id)return {stopReason:'end',assistantParts:[{type:'text',text:'Status report received.'}]};
  const parts=input.messages.flatMap(m=>m.parts),probe=parts.find(p=>p.type==='tool_result'&&p.toolCallId==='status-probe');
  if(!probe)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'status-probe',name:'k8s_get',input:{}}]};
  const report=parts.find(p=>p.type==='tool_result'&&p.toolCallId==='status-report');
  if(!report){const evidence=runtime.store.listMessages(input.sessionId).find(m=>m.role==='tool'&&m.parts.some(p=>p.type==='tool_result'&&p.toolCallId==='status-probe'));return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'status-report',name:'bot_status_report',input:{requestId,summary:'Existing work checked; no delivery repeated.',evidenceMessageIds:[evidence.id]}}]};}
  assert.equal(report.ok,true,report.content);return {stopReason:'end',assistantParts:[{type:'text',text:'Fresh status returned.'}]};
 }};
 runtime=new RawAgentRuntime({repoRoot:join(dir,'repo'),stateDir:join(dir,'state'),modelAdapter:adapter,extraTools:[{name:'k8s_get',description:'Local controlled read-only observation',inputSchema:{type:'object',properties:{}},approvalMode:'never',sideEffectLevel:'none',async execute(){checks++;return {ok:true,content:JSON.stringify({observedAt:new Date().toISOString(),status:'running'})};}}]});
 runtime.emitTrace=()=>{};t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true});});runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
 const supervisor=runtime.createBot({name:'Supervisor'});worker=runtime.createBot({name:'Worker'});
 const host={store:runtime.store,runSession:id=>runtime.runSession(id),isSessionRunning:id=>runtime.isSessionRunning(id),log:{warn(){},info(){}}},service=new BotStatusRequests(host);
 const requested=service.request(supervisor.canonicalSessionId,{targetBotId:worker.id,idempotencyKey:'runtime-status'});requestId=requested.requestId;
 for(let i=0;i<300;i++){if(service.read(supervisor.canonicalSessionId,requestId).status==='replied')break;await new Promise(r=>setTimeout(r,10));}
 const result=service.read(supervisor.canonicalSessionId,requestId);assert.equal(result.status,'replied',JSON.stringify(result));assert.equal(checks,1);assert.ok(result.replyMessageId);
 assert.equal(new BotGoalService(runtime.store,Date.now,worker.canonicalSessionId).list(worker.id).length,0);
 for(let i=0;i<100&&runtime.isSessionRunning(worker.canonicalSessionId);i++)await new Promise(r=>setTimeout(r,10));
});
