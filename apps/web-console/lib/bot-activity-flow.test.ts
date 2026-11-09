import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSteps, roomSteps, routineStep } from './bot-activity-flow.ts';

test('委派按父任务和群轮次连接到实际会话 [AC:bot-activity-flow#AC-1]',()=>{
 const base={requesterBotId:'host',targetBotId:'worker',status:'running',input:'inspect'};
 const steps=taskSteps([{...base,id:'a'},{...base,id:'b',parentTaskId:'a',delivery:{sessionId:'child',report:'ok',costUsd:0}},{...base,id:'c'}]);
 assert.equal(steps[1].parent,'a');assert.equal(steps[1].session,'child');assert.equal(steps[1].cost,0);assert.equal(steps[2].parent,undefined);
 const members=roomSteps({id:'turn',status:'completed',members:[{botId:'b',sessionId:'s',status:'done'}]},[]);
 assert.equal(members[0].session,'s');assert.equal(members[0].bot,'b');
});
test('已结束但自报阻塞的例行保留原始状态与报告 [AC:bot-activity-flow#AC-2]',()=>{
 const step=routineStep({id:'r',status:'completed',result:'**阻塞。** 没有执行。',mainSessionId:'s'},'b');
 assert.equal(step.state,'reportedBlocked');assert.equal(step.raw,'completed');assert.equal(step.session,'s');assert.equal(step.cost,undefined);
 assert.equal(routineStep({id:'r2',status:'failed',error:'denied'},'b').state,'failed');
});

test('实际对话工具调用只配对同轮回执，子会话可打开 [AC:bot-activity-flow#AC-1]',async()=>{
 const {chatFlows}=await import('./bot-activity-flow.ts');
 const rec=(seq:number,role:string,parts:Parameters<typeof chatFlows>[0][number]['parts'])=>({seq,role,parts,id:String(seq),createdAt:new Date(seq).toISOString()});
 const calls=chatFlows([rec(1,'user',[{type:'text',text:'inspect'}]),rec(2,'assistant',[{type:'tool_call',toolCallId:'x',name:'spawn_subagent'}]),rec(3,'tool',[{type:'tool_result',toolCallId:'x',name:'spawn_subagent',ok:true,content:'{"childSessionId":"session_worker"}'}]),rec(4,'user',[{type:'text',text:'new'}]),rec(5,'tool',[{type:'tool_result',toolCallId:'x',ok:false}])],'b','session_main');
 assert.equal(calls.length,1);assert.equal(calls[0].steps[0].session,'session_worker');assert.equal(calls[0].steps[0].state,'done');
});
