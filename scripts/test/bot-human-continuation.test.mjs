import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
const userTexts=input=>input.messages.filter(m=>m.role==='user').flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.text));
async function until(check,label){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out: '+label);await new Promise(r=>setTimeout(r,5));}}
async function open(fixture){const result=await fixture.call('alice','POST','/api/sessions',{mode:'chat',agentId:'general',title:'Busy accepted input',autoRun:false});assert.equal(result.status,201);const session=result.body.session;fixture.runtime.store.updateSession(session.id,{metadata:{...session.metadata,modelRef:undefined}});return session.id;}
const send=(f,id,text)=>f.call('alice','POST',`/api/sessions/${id}/messages`,{message:text,autoRun:true});
const persisted=(f,id,text)=>f.runtime.getSessionMessages(id).some(m=>m.role==='user'&&m.parts.some(p=>p.type==='text'&&p.text===text));

test('accepted input arriving during final model flight must enter a later model input [AC:bot-human-continuation#AC-1]',async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture;
 try{
  fixture=await boot(false,{modelAdapter:{name:'busy-flight-barrier',async summarizeMessages(){return ''},async runTurn(input){const snapshot=userTexts(input);inputs.push(snapshot);if(inputs.length===1){entered.resolve();await gate.promise;}return {stopReason:'end',assistantParts:[{type:'text',text:'Read '+snapshot.filter(t=>t.startsWith('busy_')).join(',')}]};}}});
  const id=await open(fixture),first=send(fixture,id,'busy_first');await Promise.race([entered.promise,first.then(r=>{throw new Error('request ended before barrier: '+JSON.stringify(r))})]);
  const second=send(fixture,id,'busy_second');await until(()=>persisted(fixture,id,'busy_second'),'second input durably accepted');assert.equal(inputs.length,1);assert.ok(!inputs[0].includes('busy_second'));
  gate.resolve();const responses=await Promise.all([first,second]);assert.ok(responses.every(r=>r.status===200));await fixture.runtime.runScheduler();await new Promise(r=>setTimeout(r,25));
  assert.ok(inputs.some(messages=>messages.includes('busy_second')),JSON.stringify({reason:'200 and durable input did not enter any model request',inputs}));
  assert.equal(inputs.filter(messages=>messages.includes('busy_second')).length,1,'accepted followup must not be duplicated');
 }finally{gate.resolve();if(fixture)await fixture.close();}
});

test('accepted input arriving during a tool wave enters the next model input even with no separate reply [AC:bot-human-continuation#AC-2]',async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture;
 try{
  fixture=await boot(false,{extraTools:[{name:'busy_barrier',description:'Fixture barrier',inputSchema:{type:'object',properties:{}},approvalMode:'never',sideEffectLevel:'none',async execute(){entered.resolve();await gate.promise;return {ok:true,content:'barrier done'}}}],modelAdapter:{name:'busy-tool-barrier',async summarizeMessages(){return ''},async runTurn(input){inputs.push(userTexts(input));if(inputs.length===1)return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:'busy_call',name:'busy_barrier',input:{}}]};return {stopReason:'end',assistantParts:[{type:'text',text:'One combined reply'}]};}}});
  const id=await open(fixture),first=send(fixture,id,'busy_tool_first');await Promise.race([entered.promise,first.then(r=>{throw new Error('request ended before barrier: '+JSON.stringify(r))})]);
  const second=send(fixture,id,'busy_tool_second');await until(()=>persisted(fixture,id,'busy_tool_second'),'second input accepted during tool');gate.resolve();const responses=await Promise.all([first,second]);assert.ok(responses.every(r=>r.status===200));assert.equal(inputs.length,2);assert.ok(inputs[1].includes('busy_tool_first'));assert.ok(inputs[1].includes('busy_tool_second'));
 }finally{gate.resolve();if(fixture)await fixture.close();}
});

for(const target of ['next-run','next-step'])test(`Lab busy ${target} inbox accepted during final flight must eventually reach model input [AC:bot-human-continuation#AC-3]`,async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture;
 try{
  fixture=await boot(false,{modelAdapter:{name:'busy-steer-barrier',async summarizeMessages(){return ''},async runTurn(input){const snapshot=userTexts(input);inputs.push(snapshot);if(inputs.length===1){entered.resolve();await gate.promise;}return {stopReason:'end',assistantParts:[{type:'text',text:'Read current snapshot'}]};}}});
  const id=await open(fixture),first=send(fixture,id,'busy_steer_first');await Promise.race([entered.promise,first.then(r=>{throw new Error('request ended before barrier: '+JSON.stringify(r))})]);
  const ack=await fixture.call('alice','POST',`/api/sessions/${id}/steer`,{text:'busy_'+target,target});assert.equal(ack.status,200);assert.ok(['queued','steered'].includes(ack.body.status));assert.ok(fixture.runtime.store.listUnclaimedInbox(id).length>0);
  gate.resolve();assert.equal((await first).status,200);await fixture.runtime.runScheduler();await new Promise(r=>setTimeout(r,25));assert.ok(inputs.some(messages=>messages.includes('busy_'+target)),JSON.stringify({reason:'accepted Lab inbox remained unconsumed',target,inputs,pending:fixture.runtime.store.listUnclaimedInbox(id)}));assert.equal(fixture.runtime.store.listUnclaimedInbox(id).length,0);
 }finally{gate.resolve();if(fixture)await fixture.close();}
});

test('autoRun false arriving during final flight persists without triggering another run [AC:bot-human-continuation#AC-4]',async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture;
 try{
  fixture=await boot(false,{modelAdapter:{name:'busy-manual-barrier',async summarizeMessages(){return ''},async runTurn(input){inputs.push(userTexts(input));entered.resolve();await gate.promise;return {stopReason:'end',assistantParts:[{type:'text',text:'first done'}]};}}});
  const id=await open(fixture),first=send(fixture,id,'busy_manual_first');await Promise.race([entered.promise,first.then(r=>{throw new Error('request ended before barrier: '+JSON.stringify(r))})]);const manual=await fixture.call('alice','POST',`/api/sessions/${id}/messages`,{message:'busy_manual_only',autoRun:false});assert.equal(manual.status,200);assert.ok(persisted(fixture,id,'busy_manual_only'));gate.resolve();await first;await fixture.runtime.runScheduler();await new Promise(r=>setTimeout(r,25));assert.equal(inputs.length,1);assert.ok(!inputs[0].includes('busy_manual_only'));
 }finally{gate.resolve();if(fixture)await fixture.close();}
});

test('original delegated task result is persisted before the human tail starts [AC:bot-human-continuation#AC-6]',async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture,workerSession,taskId;
 try{
  fixture=await boot(false,{modelAdapter:{name:'task-tail-barrier',async summarizeMessages(){return ''},async runTurn(input){if(input.sessionId!==workerSession)return {stopReason:'end',assistantParts:[{type:'text',text:'notification acknowledged'}]};const snapshot=userTexts(input);inputs.push(snapshot);if(inputs.length===1){entered.resolve();await gate.promise;return {stopReason:'end',assistantParts:[{type:'text',text:'TASK ORIGINAL RESULT'}]};}assert.equal(fixture.runtime.store.db.prepare('SELECT status FROM bot_work_tasks WHERE id=?').get(taskId).status,'completed');return {stopReason:'end',assistantParts:[{type:'text',text:'TAIL HUMAN RESULT'}]};}}});
  await fixture.call('alice','GET','/api/bot-work/default');const worker=await fixture.call('alice','POST','/api/bots',{name:'Tail worker'});assert.equal(worker.status,201);const opened=await fixture.call('alice','POST',`/api/bots/${worker.body.bot.id}/open`);assert.equal(opened.status,200);workerSession=opened.body.session.id;const session=fixture.runtime.store.getSession(workerSession);fixture.runtime.store.updateSession(workerSession,{metadata:{...session.metadata,modelRef:undefined}});
  const accepted=await fixture.call('alice','POST','/api/bot-work/tasks',{targetBotId:worker.body.bot.id,input:'original delegated task'});assert.equal(accepted.status,202);taskId=accepted.body.task.id;await entered.promise;
  const tail=send(fixture,workerSession,'busy_task_tail');await until(()=>persisted(fixture,workerSession,'busy_task_tail'),'human task tail received');gate.resolve();assert.equal((await tail).status,200);await until(()=>inputs.length===2,'task tail model turn');
  const task=await fixture.call('alice','GET',`/api/bot-work/tasks/${taskId}`);assert.equal(task.status,200);assert.equal(task.body.task.result,'TASK ORIGINAL RESULT');assert.ok(inputs[1].includes('busy_task_tail'));assert.equal(fixture.runtime.store.db.prepare('SELECT status FROM bot_work_tasks WHERE id=?').get(taskId).status,'completed');
 }finally{gate.resolve();if(fixture)await fixture.close();}
});

test('configured overflow summary acknowledges its accepted source receipts after the summary enters model input [AC:bot-human-continuation#AC-3]',async()=>{
 const gate=deferred(),entered=deferred(),inputs=[];let fixture;
 try{
  fixture=await boot(false,{modelAdapter:{name:'overflow-input-barrier',async summarizeMessages(){return ''},async runTurn(input){inputs.push(input.messages.flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.text)));if(inputs.length===1){entered.resolve();await gate.promise;}return {stopReason:'end',assistantParts:[{type:'text',text:'Read overflow summary'}]};}}});
  fixture.runtime.store.setDaemonControl('loop_settings',{inboxOverflowCap:2});const id=await open(fixture),first=send(fixture,id,'overflow_first');await entered.promise;
  for(const text of ['overflow_old_a','overflow_old_b','overflow_new_c']){const ack=await fixture.call('alice','POST',`/api/sessions/${id}/steer`,{text,target:'next-step'});assert.equal(ack.status,200);}
  const acceptedPending=fixture.runtime.store.getDaemonControl('session.humanContinuation:'+id).pending;assert.equal(acceptedPending.filter(request=>request.kind==='steer').length,3);assert.ok(acceptedPending.filter(request=>request.text?.startsWith('overflow_old')).every(request=>request.summaryId));
  gate.resolve();await first;await until(()=>inputs.length>=2,'overflow model turn');await new Promise(r=>setTimeout(r,25));
  assert.ok(inputs[1].some(text=>text.includes('[inbox overflow]')));const pending=fixture.runtime.store.getDaemonControl('session.humanContinuation:'+id)?.pending??[];assert.equal(pending.length,0,JSON.stringify({reason:'summary was model input but accepted source receipts remained pending',pending,inputs}));
 }finally{gate.resolve();if(fixture)await fixture.close();}
});
