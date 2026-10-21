import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeGoalTool } from '../dist/bots/goals/tool-gateway.js';
function fixture(approvalMode='never') {
 const messages=[],approvals=[];let executions=0;
 const tool={name:'goal_test_write',description:'fixture',inputSchema:{type:'object'},approvalMode,sideEffectLevel:'write',execute:async()=>{executions++;return {ok:true,content:'written'}}};
 const session={id:'s',mode:'chat',metadata:{permissionMode:'auto'},status:'running',agentId:'a'};
 const context={session,agent:{id:'a',name:'Agent',instructions:'',capabilities:[]},repoRoot:'/tmp',stateDir:'/tmp'};
 const deps={tools:[tool],store:{assertCurrentWriter(){},appendMessage:(_id,role,parts)=>messages.push({role,parts}),foldMessages:()=>messages,listApprovals:()=>approvals,createApproval:input=>{const row={...input,id:'ap1',status:'pending',createdAt:new Date().toISOString()};approvals.push(row);return row},deleteApproval(){},getTask(){},updateTask(){}},envApprovalPolicy:undefined,maxParallelToolCalls:1,modelAdapter:{name:'fixture'},stateDir:'/tmp',emitTrace(){}};
 return {messages,approvals,context,deps,tool,executions:()=>executions};
}
test('nested goal dispatch uses authorized tools and stores paired results [AC:bot-multi-goal-coordination#AC-6]',async()=>{
 const f=fixture();const request={deps:f.deps,context:f.context,tools:[f.tool],name:f.tool.name,args:{},callId:'stable-call'};
 assert.equal((await invokeGoalTool(request)).ok,true);assert.equal(f.executions(),1);
 assert.equal(f.messages.flatMap(m=>m.parts).filter(p=>p.type==='tool_call').length,1);
 assert.equal(f.messages.flatMap(m=>m.parts).filter(p=>p.type==='tool_result').length,1);
 assert.equal((await invokeGoalTool(request)).ok,true);assert.equal(f.executions(),1);
 const blocked=await invokeGoalTool({...request,tools:[],callId:'denied'});assert.equal(blocked.ok,false);assert.equal(f.executions(),1);
});
test('approval wait stays paired, resumes with same call id and rejected approval never executes [AC:bot-multi-goal-coordination#AC-6]',async()=>{
 const f=fixture('always');const request={deps:f.deps,context:f.context,tools:[f.tool],name:f.tool.name,args:{},callId:'approval-call'};
 const waiting=await invokeGoalTool(request);assert.equal(waiting.waitingApproval,true);assert.equal(f.executions(),0);
 assert.deepEqual(f.messages.flatMap(m=>m.parts).map(p=>p.type),['tool_call','tool_result']);
 f.approvals[0].status='approved';assert.equal((await invokeGoalTool(request)).ok,true);assert.equal(f.executions(),1);
 assert.ok(f.messages.flatMap(m=>m.parts).every(p=>p.toolCallId==='approval-call'));
 const denied=fixture('always');const r={deps:denied.deps,context:denied.context,tools:[denied.tool],name:denied.tool.name,args:{},callId:'reject'};
 await invokeGoalTool(r);denied.approvals[0].status='rejected';assert.equal((await invokeGoalTool(r)).ok,false);assert.equal(denied.executions(),0);
});
