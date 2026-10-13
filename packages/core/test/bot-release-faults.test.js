import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, arch } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { resolveBotPrincipal } from '../dist/bots/bot-identity.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { dispatchBotTask,enqueueBotMessage,tickBotWork,openBotWorkContext,getBotTask,cancelBotTask,recoverBotWork,updateBotWorkSettings } from '../dist/bots/bot-work.js';
import { sanitizeSpawnEnv } from '../dist/sandbox/env-sanitizer.js';
import { readExecutableFingerprint } from '../../../scripts/bot-release/executable-fingerprint.mjs';
const executableFingerprint=readExecutableFingerprint();
const releaseRunId=process.env.BOT_RELEASE_RUN_ID??String(Date.now());
assert.match(releaseRunId,/^[a-zA-Z0-9_-]+$/);

function tempDir(prefix){const base=resolve('test-results/bot-release-faults/tmp');mkdirSync(base,{recursive:true});return mkdtempSync(join(base,prefix));}

function report(name,data){
  const dir=resolve('test-results/bot-release-faults');mkdirSync(dir,{recursive:true});
  const sha=execFileSync('git',['rev-parse','HEAD'],{env:sanitizeSpawnEnv(),encoding:'utf8'}).trim();
  const dirty=execFileSync('git',['status','--porcelain'],{env:sanitizeSpawnEnv(),encoding:'utf8'}).trim().length>0;
  writeFileSync(join(dir,`${name}.json`),JSON.stringify({sha,workspaceDirty:dirty,executableFingerprint,createdAt:new Date().toISOString(),node:process.version,hardware:{cpuCount:cpus().length,cpuModel:cpus()[0]?.model,totalMemoryBytes:totalmem(),platform:platform(),arch:arch()},...data},null,2));
}
function fixture(){
  const dir=tempDir('bot-faults-'),path=join(dir,'state.db');const store=new SqliteStateStore(path);
  const facade={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};
  const a=createBot(facade,{name:'SeedCoordinator'}),b=createBot(facade,{name:'SeedWorker'});
  const principal=resolveBotPrincipal(store);const running=new Set();let executions=0;
  const host={store,log:{info(){},warn(){},error(){}},createChatSession:input=>createChatSession(facade,input),isSessionRunning:id=>running.has(id),cancelSession:id=>store.updateSession(id,{status:'idle'}),
    async runSession(id){assert.ok(!running.has(id),'single execution per context');running.add(id);store.updateSession(id,{status:'running'});executions++;try{store.appendMessage(id,'assistant',[{type:'text',text:`result:${executions}`}]);store.updateSession(id,{status:'idle'});}finally{running.delete(id);}}};
  const rooms=new BotRoomService(host);const room=rooms.create(principal,{title:'Seeded fault room',botIds:[a.id,b.id]});
  return {store,dir,path,host,rooms,room,a,b,principal,executions:()=>executions};
}
function rng(seed){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};}

test('fixed seed at least 1000 mixed Bot and Room transitions retain accepted work and task truth [AC:bot-release-readiness#AC-1]',async()=>{
  const seed=0x20261013,steps=Number(process.env.BOT_RELEASE_SEQUENCES??1000),next=rng(seed),f=fixture();const accepted=new Set(),roomAccepted=new Set(),tasks=[],trace=[];const counts={};
  assert.ok(Number.isInteger(steps)&&steps>=1000&&steps<=100000,'release sequence count must be 1000–100000');
  const runId=releaseRunId;
  let latestMessage,latestRoom;
  updateBotWorkSettings(f.store,{perBot:100000,perPrincipal:100000});
  const flush=async()=>{await tickBotWork(f.host);await new Promise(resolve=>setImmediate(resolve));};
  for(let step=0;step<steps;step++){
    const op=next()%10;counts[op]=(counts[op]??0)+1;trace.push({step,op});
    try{
      if(op===0){const input={text:`room-${step}`,idempotencyKey:`room-${step}`,mentions:[f.a.id,f.b.id]};const first=f.rooms.send(f.principal,f.room.id,input);assert.equal(f.rooms.send(f.principal,f.room.id,input).message.id,first.message.id);roomAccepted.add(first.message.id);latestRoom=first.message.id;}
      else if(op===1)await f.rooms.tick();
      else if(op===2){f.rooms.patch(f.principal,f.room.id,{status:'paused'});await f.rooms.tick();f.rooms.resume(f.principal,f.room.id);}
      else if(op===3){f.rooms.stop(f.principal,f.room.id);f.rooms.resume(f.principal,f.room.id);}
      else if(op===4){const input={principal:f.principal,requesterBotId:f.a.id,targetBotId:f.b.id,input:`task-${step}`,idempotencyKey:`task-${step}`};const task=dispatchBotTask(f.host,input);assert.equal(dispatchBotTask(f.host,input).id,task.id);tasks.push(task.id);}
      else if(op===5)await flush();
      else if(op===6||op===7){await flush();const context=openBotWorkContext(f.host,f.b.id,f.principal);f.store.updateSession(context.id,{status:op===6?'running':'waiting_approval'});const input={principal:f.principal,senderBotId:f.a.id,targetBotId:f.b.id,message:`message-${step}`,idempotencyKey:`msg-${step}`};const first=enqueueBotMessage(f.host,input);assert.equal(first.queued,true);assert.equal(enqueueBotMessage(f.host,input).messageId,first.messageId);accepted.add(first.messageId);latestMessage=first.messageId;f.store.updateSession(context.id,{status:'idle'});}
      else if(op===8&&tasks.length){const id=tasks[next()%tasks.length];cancelBotTask(f.host,f.principal,id);}
      else if(op===9){await flush();const task=dispatchBotTask(f.host,{principal:f.principal,requesterBotId:f.a.id,targetBotId:f.b.id,input:`interrupted-${step}`,idempotencyKey:`crash-${step}`});tasks.push(task.id);f.store.db.prepare("UPDATE bot_work_tasks SET status='running' WHERE id=?").run(task.id);f.store.db.prepare("UPDATE bot_work_messages SET status='processing' WHERE task_id=? AND kind='task'").run(task.id);recoverBotWork(f.store);assert.equal(getBotTask(f.store,f.principal,task.id).status,'unknown');}
      if(latestMessage)assert.ok(f.store.db.prepare('SELECT id FROM bot_work_messages WHERE id=?').get(latestMessage),'accepted Bot input retained');
      if(latestRoom)assert.ok(f.store.db.prepare('SELECT id FROM bot_room_messages WHERE id=?').get(latestRoom),'accepted Room input retained');
      const latestTask=tasks.at(-1);if(latestTask){const task=getBotTask(f.store,f.principal,latestTask);assert.ok(task);if(task.status==='completed')assert.ok(task.result?.trim(),'completion requires a persisted result');}
    }catch(error){report(`seed-${steps}-${runId}-failure`,{seed,steps,runId,step,op,error:String(error),trace});throw error;}
  }
  for(let i=0;i<steps*3;i++){
    await flush();await f.rooms.tick();
    const remaining=f.store.db.prepare("SELECT (SELECT COUNT(*) FROM bot_work_messages WHERE status IN ('pending','processing'))+(SELECT COUNT(*) FROM bot_room_turns WHERE status IN ('queued','running','waiting_approval')) AS n").get().n;
    if(remaining===0)break;
  }
  for(const id of accepted){const row=f.store.db.prepare('SELECT status FROM bot_work_messages WHERE id=?').get(id);assert.ok(['processed','failed'].includes(row.status));}
  const pendingRooms=f.rooms.turns(f.principal,f.room.id).filter(turn=>['queued','running','waiting_approval'].includes(turn.status));assert.equal(pendingRooms.length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM bot_room_messages WHERE room_id=? AND data LIKE ?').get(f.room.id,'%"type":"user"%').n,roomAccepted.size);
  for(const id of tasks){const task=getBotTask(f.store,f.principal,id);assert.ok(task);if(task.status==='completed')assert.ok(task.result?.trim());}
  const config={seed,steps,operations:10,queueLimits:{perBot:100000,perPrincipal:100000}};report(`seed-${steps}-${runId}`,{...config,runId,configHash:createHash('sha256').update(JSON.stringify(config)).digest('hex'),counts,acceptedBotMessages:accepted.size,acceptedRoomMessages:roomAccepted.size,tasks:tasks.length,executions:f.executions(),result:'pass'});
  f.store.db.close();
  rmSync(f.dir,{recursive:true,force:true});
});

test('SIGKILL after durable Room receive keeps queued input and fences unknown work [AC:bot-release-readiness#AC-2]',async t=>{
  const dir=tempDir('bot-kill-'),path=join(dir,'state.db');
  const child=spawn(process.execPath,[resolve('scripts/bot-release/room-kill-fixture.mjs'),path],{env:sanitizeSpawnEnv(),stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let stdout='',stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const ready=await new Promise((resolveReady,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`fixture timeout: ${stderr}`)),10000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timeout);try{resolveReady(JSON.parse(stdout.split('\n')[0]));}catch(error){reject(error);}}});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error(`fixture exited before ready: ${stderr}`));});
  });
  const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);const [,signal]=await exited;assert.equal(signal,'SIGKILL');
  assert.equal(ready.executableHash,executableFingerprint.hash,'candidate binaries stayed unchanged during the child fixture');
  const store=new SqliteStateStore(path);const principal=resolveBotPrincipal(store);const facade={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};const runs=[];
  const rooms=new BotRoomService({store,createChatSession:input=>createChatSession(facade,input),cancelSession(){},async runSession(id){runs.push(id);store.appendMessage(id,'assistant',[{type:'text',text:'queued work finished'}]);store.updateSession(id,{status:'idle'});}});
  const before=rooms.turns(principal,ready.roomId);assert.equal(before[0].status,'unknown');assert.equal(before[1].status,'queued');
  await rooms.tick();
  const after=rooms.turns(principal,ready.roomId);assert.equal(after[0].status,'unknown');assert.equal(after[1].status,'completed');
  assert.equal(store.getDaemonControl('room.kill.sideEffects'),1,'unconfirmed side effect was not replayed');
  assert.equal(runs.length,1);assert.notEqual(runs[0],ready.runningSessionId);
  assert.ok(rooms.messages(principal,ready.roomId).messages.some(message=>message.id===ready.queuedMessageId));
  report(`sigkill-recovery-${releaseRunId}`,{runId:releaseRunId,result:'pass',signal,received:2,unknown:1,queuedCompleted:1,sideEffects:1});store.db.close();rmSync(dir,{recursive:true,force:true});
});

test('SIGKILL during delegated tool write preserves canonical history without replaying unresolved tools [AC:bot-release-readiness#AC-2]',async t=>{
  const dir=tempDir('bot-work-kill-'),path=join(dir,'state.db');
  const child=spawn(process.execPath,[resolve('scripts/bot-release/bot-work-kill-fixture.mjs'),path],{env:sanitizeSpawnEnv(),stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let stdout='',stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const ready=await new Promise((resolveReady,reject)=>{const timeout=setTimeout(()=>reject(new Error(`fixture timeout: ${stderr}`)),10000);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n')){clearTimeout(timeout);try{resolveReady(JSON.parse(stdout.split('\n')[0]));}catch(error){reject(error);}}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error(`fixture exited: ${stderr}`));});});
  const exited=once(child,'exit');child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');
  assert.equal(ready.executableHash,executableFingerprint.hash,'candidate binaries stayed unchanged during the child fixture');
  const store=new SqliteStateStore(path);const principal=resolveBotPrincipal(store);recoverBotWork(store);
  assert.equal(getBotTask(store,principal,ready.runningTaskId).status,'unknown');
  assert.equal(getBotTask(store,principal,ready.queuedTaskId).status,'queued');
  assert.equal(store.getSession(ready.sessionId).metadata.canonicalBotChat,true);
  assert.ok(JSON.stringify(store.listMessages(ready.sessionId)).includes('UNCONFIRMED_EFFECT_TRIGGER'),'raw trace retained');
  assert.ok(!JSON.stringify(store.foldMessages(ready.sessionId)).includes('UNCONFIRMED_EFFECT_TRIGGER'),'unresolved input removed from model view');
  assert.ok(!store.foldMessages(ready.sessionId).flatMap(message=>message.parts).some(part=>part.type==='tool_call'&&part.toolCallId==='unconfirmed-write'),'unresolved tool wave removed from active view');
  const runs=[];const host={store,log:{info(){},warn(){},error(){}},async runSession(id){runs.push(id);store.appendMessage(id,'assistant',[{type:'text',text:'new task completed'}]);store.updateSession(id,{status:'idle'});}};
  await tickBotWork(host);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(getBotTask(store,principal,ready.queuedTaskId).status,'completed');
  assert.equal(getBotTask(store,principal,ready.runningTaskId).status,'unknown');
  assert.equal(runs[0],ready.sessionId,'same canonical conversation resumes safely');
  assert.equal(store.getDaemonControl('bot.kill.sideEffects'),1,'unconfirmed effect not replayed');
  report(`sigkill-bot-work-${releaseRunId}`,{runId:releaseRunId,result:'pass',signal,unknown:1,queuedCompleted:1,sideEffects:1,canonicalPreserved:true,rawHistoryPreserved:true});store.db.close();rmSync(dir,{recursive:true,force:true});
});
