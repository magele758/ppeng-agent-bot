/** Opt-in real-model HTTP acceptance. Uses isolated state and harmless local files. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boot} from '../test/helpers/bot-http-fixture.mjs';
import {createModelAdapterFromEnv} from '../../packages/core/dist/model/model-adapters.js';
import {tickBotGoals} from '../../packages/core/dist/bots/goals/scheduler.js';
const repoRoot=mkdtempSync(join(tmpdir(),'bot-live-repo-'));
const stateDir=mkdtempSync(join(tmpdir(),'bot-live-state-'));
writeFileSync(join(repoRoot,'input.txt'),'17\n25\n');
const adapter=createModelAdapterFromEnv(process.env);
const originalRun=adapter.runTurn.bind(adapter);
adapter.runTurn=async input=>{console.log(JSON.stringify({event:'model',sid:input.sessionId,goalTools:input.tools?.filter(t=>t.name.startsWith('goal_')).map(t=>t.name)}));return originalRun(input);};
const f=await boot(false,{repoRoot,stateDir,modelAdapter:adapter});
const report={model:process.env.RAW_AGENT_MODEL_NAME,repoRoot,stateDir,scenarios:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,path,body){const r=await f.call('alice',method,path,body);assert.ok(r.status<300,JSON.stringify(r));return r.body;}
async function snapshot(bot,sid){return {goals:(await api('GET',`/api/bots/${bot.id}/goals?sessionId=${sid}`)).goals,approvals:f.runtime.listApprovals().filter(a=>f.runtime.getSession(a.sessionId)?.metadata.botId===bot.id),sessions:f.runtime.store.listSessions().filter(s=>s.id===sid||s.parentSessionId===sid).map(s=>({session:s,messages:f.runtime.getSessionMessages(s.id)}))};}
async function run(name,prompt,control){
 if(process.argv[2] && name!==process.argv[2])return;
 const {bot}=await api('POST','/api/bots',{name:`Live ${name}`});
 const {session}=await api('POST',`/api/bots/${bot.id}/open`,{});const sid=session.id;
 console.log(JSON.stringify({event:'start',name,sid,stateDir}));
 let done=false,error;const flight=api('POST',`/api/sessions/${sid}/messages`,{message:prompt}).catch(e=>{error=String(e)}).finally(()=>done=true);
 let acted=false;
 const deadline=Date.now()+240000;
 while(Date.now()<deadline){
  if(control&&!acted)acted=await control({bot,sid,api,runtime:f.runtime,repoRoot});
  if(done){await tickBotGoals(f.runtime.goalRuntimeHost());const s=await snapshot(bot,sid);if(s.goals.every(g=>['completed','failed','blocked','cancelled','paused'].includes(g.status))||s.approvals.some(a=>a.status==='pending'))break;}
  await delay(500);
 }
 if(!done)f.runtime.cancelSession(sid);
 await flight;
 if(name==='cancel'||name==='amend')await delay(32000);
 const s=await snapshot(bot,sid);
 let validationError;
 try {
  assert.equal(error,undefined);
  assert.equal(s.goals.length,1,'One task must retain one goal');
  assert.equal(s.goals[0].status,name==='cancel'?'cancelled':'completed');
  if(name==='file')assert.equal(readFileSync(join(repoRoot,'sum.txt'),'utf8').trim(),'42');
  if(name==='planner')assert.ok(s.sessions.some(s=>s.session.agentId==='planner'),'An actual planner must run');
  if(name==='approval'){assert.ok(acted);assert.equal(readFileSync(join(repoRoot,'approval.txt'),'utf8'),'approved');}
  if(name==='cancel'){assert.ok(acted);assert.equal(existsSync(join(repoRoot,'cancelled.txt')),false,'Late cancelled command must not write');}
  if(name==='amend'){assert.ok(acted);assert.equal(s.goals[0].revision,2);assert.equal(readFileSync(join(repoRoot,'amended.txt'),'utf8'),'revised');}
  assert.equal(readFileSync(join(repoRoot,'input.txt'),'utf8'),'17\n25\n');
 }catch(e){validationError=String(e);process.exitCode=1;}
 report.scenarios.push({name,prompt,error,validationError,passed:!validationError,...s});
 writeFileSync(join(stateDir,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({event:'result',name,passed:!validationError,validationError,goals:s.goals.map(g=>({id:g.id,status:g.status,strategy:g.strategy,progress:g.progress,blockedReason:g.blockedReason})),approvals:s.approvals.map(a=>({id:a.id,tool:a.toolName,status:a.status}))}));return s;
}
try{
 await run('file','读取工作目录 input.txt 的两个整数，计算它们的和，并将结果写入 sum.txt。实际读取验证 sum.txt 内容为 42 后报告完成。不要修改其他文件。');
 await run('planner','为这个小型数字求和工具制定产品规划，给出目标用户、三项验收条件和实施顺序。请完成规划任务即可，不要写代码。');
 await run('approval','在工作目录使用 bash 的 direct 隔离执行 printf approved > approval.txt，读取文件验证结果。必须走正常审批，批准前不能写文件。',async({runtime,api,bot})=>{const a=runtime.listApprovals('pending').find(a=>a.toolName==='bash'&&runtime.getSession(a.sessionId)?.metadata.botId===bot.id);if(!a)return false;assert.equal(existsSync(join(repoRoot,'approval.txt')),false);await api('POST',`/api/approvals/${a.id}/approve`,{});return true;});
 await run('cancel','使用 bash 执行 sleep 30 && printf late > cancelled.txt。执行结束后读取结果。',async({bot,sid,api,runtime})=>{
 const calls=runtime.store.listSessions().filter(s=>s.id===sid||s.parentSessionId===sid).flatMap(s=>runtime.getSessionMessages(s.id)).flatMap(m=>m.parts).filter(p=>p.type==='tool_call'&&['bash','bg_run'].includes(p.name));if(!calls.length)return false;
 await delay(1500);const {goals}=await api('GET',`/api/bots/${bot.id}/goals?sessionId=${sid}`);if(!goals[0])return false;
 await api('POST',`/api/bots/${bot.id}/goals/${goals[0].id}/actions`,{sessionId:sid,action:'cancel'});return true;
 });
 await run('amend','使用 bash 执行 sleep 30 && printf original > amended.txt。执行结束后读取结果。',async({bot,sid,api,runtime})=>{
 const calls=runtime.store.listSessions().filter(s=>s.id===sid||s.parentSessionId===sid).flatMap(s=>runtime.getSessionMessages(s.id)).flatMap(m=>m.parts).filter(p=>p.type==='tool_call'&&['bash','bg_run'].includes(p.name));if(!calls.length)return false;
 await delay(1500);const {goals}=await api('GET',`/api/bots/${bot.id}/goals?sessionId=${sid}`);if(!goals[0])return false;
 await api('POST',`/api/sessions/${sid}/messages`,{message:`[goal:${goals[0].id}] 追加约束：停止旧命令，不再等待，把 amended.txt 的内容改为 revised，读取验证后完成。`});return true;
 });
}finally{f.runtime.cancelAllSessions();await Promise.allSettled([...f.runtime.runningSessions.values()]);await f.close();console.log(JSON.stringify({report:join(stateDir,'report.json')}));}
