/** Real, sequential OS processes. No store writes or lifecycle mocks in this supervisor. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { CASES } from './restart-cases.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const live = new Set();
process.on('SIGTERM', () => { for (const p of live) p.kill('SIGKILL'); process.exit(2); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function service(config, mutation, executable=process.execPath) {
  const args = ['--import', join(ROOT, 'scripts/formal/restart-register.mjs'), join(ROOT, 'scripts/formal/restart-child.mjs'), JSON.stringify(config)];
  if (mutation) args.push('--mutation', mutation);
  const child = spawn(executable, args, { cwd: ROOT, env: sanitizeScriptEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }), stdio: ['ignore','ignore','pipe','ipc'] });
  live.add(child);
  let seq=0, stderr='', exited=false, exitInfo;
  const pending=new Map();
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exit=new Promise(resolve=>{const finish=(code,signal)=>{if(exited)return; exited=true;exitInfo={code,signal};live.delete(child);readyReject(new Error('Service exited before readiness: '+stderr.slice(-800)));for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(new Error('Service exited during request: '+stderr.slice(-800)));}pending.clear();resolve(exitInfo); };child.once('exit',finish);child.once('close',finish);});
  child.once('error',e=>{readyReject(e);});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-40000);});
  child.on('message',msg=>{if(msg.ready){readyResolve(msg);return;}const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);if(msg.error){const error=new Error(msg.error);error.product=true;p.reject(error);}else p.resolve(msg.value);});
  const timer=setTimeout(()=>readyReject(new Error('Service readiness timed out: '+stderr.slice(-800))),12000);
  try { await ready; } catch(e){child.kill('SIGKILL');await exit;throw e;}finally{clearTimeout(timer);}
  return { pid:child.pid,
    rpc(command,args) { if(exited)return Promise.reject(new Error('Service already exited'));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Service command timed out: '+command+'; '+stderr.slice(-800)));},12000);pending.set(id,{resolve,reject,timer});child.send({id,command,args},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});}); },
    async stop(signal='SIGTERM') { if(!exited)child.kill(signal);const t=setTimeout(()=>child.kill('SIGKILL'),6000);try{return await exit;}finally{clearTimeout(t);} },
    get exited(){return exited;}, get exitInfo(){return exitInfo;}, get mutationLoaded(){return !!mutation&&stderr.includes('RESTART_MUTATION_LOADED:'+mutation);}
  };
}
function norm(raw) {
  return { history:raw.messages.map(m=>({role:m.role,parts:m.parts.map(p=>p.type==='text'?{type:p.type,text:p.text.replace(/(?:session|run|approval)_[a-f0-9]+/g,'<durable-id>')}:p)})), status:raw.status, outcome:raw.outcome?{kind:raw.outcome.kind,reason:raw.outcome.reason}:null, interrupt:!!raw.interrupt,
    approvals:raw.approvals.map((a,i)=>({id:`approval-${i+1}`,tool:a.tool,status:a.status,args:a.args})),
    parts:raw.messages.flatMap(m=>m.parts).filter(p=>['tool_call','tool_result'].includes(p.type)).map(p=>({type:p.type,id:p.toolCallId,name:p.name,ok:p.ok,content:p.content})),
    work:raw.ledger.map(e=>({generation:e.generation,kind:e.kind,id:e.id,call:e.call,parts:e.parts})) };
}
const parts=s=>s.messages.flatMap(m=>m.parts);
function paired(ps) { const pending=new Map();for(const p of ps){if(p.type==='tool_call'){if(pending.has(p.toolCallId))return false;pending.set(p.toolCallId,0);}if(p.type==='tool_result'){if(!pending.has(p.toolCallId)||pending.get(p.toolCallId)>0)return false;pending.set(p.toolCallId,1);}}return [...pending.values()].every(n=>n===1); }
const toolWork=s=>s.ledger.filter(e=>e.kind==='tool').map(e=>e.id);
const isInterrupted=s=>!['running','waiting_approval'].includes(s.status)&&!s.interrupt&&(['aborted','unknown','interrupted'].includes(s.outcome?.kind)||(s.outcome?.kind==='failed'&&/interrupt|restart|unknown/.test(s.outcome?.reason??'')));
async function runCase(c,mutation,childExecutable){
  const dir=mkdtempSync(join(tmpdir(),'restart-runtime-'));mkdirSync(join(dir,'repo'));
  const row={name:c.name,mode:c.mode,termination:c.termination,status:'incomplete',events:[],snapshots:[],processes:[],checks:[]};let child,oldPid,sid,generation=0;
  const check=(criterion,label,ok,expected,actual)=>row.checks.push({criterion,label,ok:!!ok,expected,actual});
  const snap=(event,raw)=>{row.events.push(event);row.snapshots.push({process:`process-${generation}`,run:event.includes('fresh')?'run-2':'run-1',...norm(raw)});return raw;};
  const boot=async()=>{if(child&&!child.exited)throw new Error('Predecessor still alive');const previous=child;generation++;child=await service({dir,phase:c.phase,mode:c.mode,generation,sid},mutation,childExecutable);row.processes.push({generation,freshPid:child.pid!==oldPid,exitedBeforeNext:!previous||previous.exited,previousExit:previous?.exitInfo??null});oldPid=child.pid;row.events.push(`process-${generation}: production runtime startup`);};
  const stop=async(signal)=>{const r=await child.stop(signal);row.mutationLoaded=!!row.mutationLoaded||child.mutationLoaded;row.events.push(`process-${generation}: exit ${r.code??r.signal}`);if(signal==='SIGKILL'&&r.signal!=='SIGKILL')throw new Error('Crash injection did not terminate at the requested cut');if(signal==='SIGTERM'&&r.code!==0)throw new Error('Normal shutdown did not complete');};
  const get=async label=>snap(label,await child.rpc('snapshot'));
  const attempt=async(command,args,criterion,event)=>{try{return snap(event,await child.rpc(command,args));}catch(error){if(!error.product)throw error;const actual=error.message.replaceAll(dir,'<temp>').replace(/(?:session|run)_[a-f0-9]+/g,'<durable-id>');check(criterion,event+' public operation must complete',false,'operation accepted without writer/state conflict',actual);return get(event+' rejected; persisted state read back');}};
  try{
    await boot();let before=snap('old run reached observed durable stage',await child.rpc('prepare'));sid=before.sid;
    if(['model','tool','partial-tools','retry'].includes(c.phase)&&before.status!=='running')throw new Error('Invalid phase cut: execution no longer running');
    const approval=c.phase.startsWith('approval');
    if(approval){check('AC-3','real pending approval records exist',before.approvals.length===(c.phase==='approval-one'?1:2),'expected number',before.approvals.length);}
    if(c.action.startsWith('partial'))before=snap('first decision persisted',await child.rpc('decide',[[0,c.action==='partial-rejected'?'rejected':'approved']]));
    if(c.action==='cancel-before-stop')before=snap('cancelled retry persisted before process stop',await child.rpc('cancel'));
    if(c.action==='settled')before=snap('all decisions persisted before execution',await child.rpc('decide',[[0,'approved'],[1,'approved']]));
    if(c.phase==='partial-tools')check('AC-9','precondition: one saved result and one observed effect without result',parts(before).some(p=>p.type==='tool_result'&&p.toolCallId==='a'&&p.ok)&&!parts(before).some(p=>p.type==='tool_result'&&p.toolCallId==='b')&&toolWork(before).join(',')==='a,b','saved a; unconfirmed b',norm(before));
    await stop(c.termination);await boot();let after=await get('new process read persisted state');
    if(['model','tool','partial-tools','retry'].includes(c.phase)){
      check(c.phase==='retry'?'AC-2':'AC-1','lost execution has a truthful settled outcome',isInterrupted(after),'interrupted/unknown, not running or successful',norm(after));
      await pause(2050);const quiet=await get('old retry deadline passed');
      check(c.phase==='retry'?'AC-2':'AC-1','no automatic old model/tool work after boot',quiet.ledger.filter(e=>e.generation===2).length===0,0,quiet.ledger.filter(e=>e.generation===2));after=quiet;
    }
    if(approval){
      check('AC-3','durable approval identities, contents and decisions preserved',JSON.stringify(before.approvals)===JSON.stringify(after.approvals),before.approvals.map(a=>({tool:a.tool,status:a.status})),after.approvals.map(a=>({tool:a.tool,status:a.status})));
      if(after.approvals.some(a=>a.status==='pending'))check('AC-3','still waiting without executing',after.status==='waiting_approval'&&after.outcome?.kind==='waiting_approval'&&after.interrupt&&toolWork(after).length===0,'waiting with no tools',norm(after));
      if(c.action.startsWith('partial'))check('AC-4','partial decision remains saved and waiting',JSON.stringify(before.approvals)===JSON.stringify(after.approvals)&&after.status==='waiting_approval'&&after.outcome?.kind==='waiting_approval','first decision retained; waiting',norm(after));
    }
    if(['one','resume','settled','mixed','rejected'].includes(c.action)){
      const decisions=after.approvals.map((a,i)=>[i,c.action==='rejected'||(c.action==='mixed'&&i===1)?'rejected':'approved']);
      await attempt('decide',decisions,'AC-5','remaining decisions recorded');after=await attempt('resume',undefined,'AC-5','resume approved persisted wave');
      const expected=decisions.filter(([,d])=>d==='approved').map(([i])=>i===0?'a':'b');
      check('AC-5','only permitted unfinished operations execute once',JSON.stringify(toolWork(after))===JSON.stringify(expected),expected,toolWork(after));
      const rejected=parts(after).filter(p=>p.type==='tool_result'&&!p.ok&&/reject/i.test(p.content)).length;
      check('AC-5','rejections recorded and wait cleared',!after.interrupt&&!['running','waiting_approval'].includes(after.status)&&rejected===decisions.filter(([,d])=>d==='rejected').length,'settled, rejection results',norm(after));
      const work=toolWork(after);await attempt('decide',decisions,'AC-5','repeat decisions');after=await attempt('resume',undefined,'AC-5','repeat decision and resume');
      check('AC-5','repeat requests do not replay saved tools or recreate approvals',JSON.stringify(work)===JSON.stringify(toolWork(after))&&after.approvals.length===before.approvals.length&&paired(parts(after)),work,toolWork(after));
    }
    if(['cancel','partial-cancel'].includes(c.action)){
      const cancelled=await attempt('cancel',undefined,'AC-6','cancel recovered approval');const done=await attempt('decide',cancelled.approvals.map((_,i)=>[i,'approved']),'AC-6','late old approval decision');
      check('AC-6','cancellation cleans pending approval and fences late decisions',done.outcome?.kind==='aborted'&&!done.interrupt&&!done.approvals.some(a=>a.status==='pending')&&toolWork(done).length===0,'aborted, no pending or execution',norm(done));
      await stop('SIGTERM');await boot();after=await get('boot after cancelled approval');
      check('AC-6','cancelled approval stays cancelled on another boot',JSON.stringify(norm(done))===JSON.stringify(norm(after)),'same cancelled snapshot',norm(after));
      const oldWork=toolWork(after);after=await attempt('fresh',undefined,'AC-7','fresh run after old approval cancellation');check('AC-7','cancelled old approval does not drive new run',!['running','waiting_approval'].includes(after.status)&&!after.interrupt&&JSON.stringify(toolWork(after))===JSON.stringify(oldWork),'fresh completion without old tools',norm(after));
    }
    if(c.action==='fresh'||c.action==='inspect-tools'){
      const oldTools=toolWork(after);after=await attempt('fresh',undefined,'AC-7','fresh explicit run');
      check('AC-7','fresh run ends separately without old work replay',after.status===(c.mode==='task'?'completed':'idle')&&!after.interrupt&&JSON.stringify(toolWork(after))===JSON.stringify(oldTools)&&after.ledger.filter(e=>e.generation===2&&e.kind==='model').length===1,'fresh completion, one new request, no tool replay',norm(after));
    }
    if(c.phase==='partial-tools'){
      const results=parts(after).filter(p=>p.type==='tool_result');
      check('AC-9','saved result retained; unconfirmed tool is not fabricated success or replayed',results.filter(p=>p.toolCallId==='a'&&p.ok&&p.content==='result-a').length===1&&!results.some(p=>p.toolCallId==='b'&&p.ok)&&toolWork(after).join(',')==='a,b','a once, b not successful or repeated',norm(after));
      const views=after.ledger.filter(e=>e.generation===2&&e.kind==='model');
      check('AC-9','model view is paired and unconfirmed work represented as interrupted',views.length===1&&paired(views[0].parts.map(p=>({...p,toolCallId:p.id})))&&views[0].parts.some(p=>p.type==='tool_result'&&p.id==='b'&&!p.ok&&/interrupt|unknown|cancel/i.test(p.content)),'paired model view with non-success b',views);
    }
    if(c.action==='terminal')check('AC-8','terminal state and persisted data unchanged on boot',JSON.stringify(norm(before))===JSON.stringify(norm(after)),'unchanged',norm(after));
    if(!['cancel','partial-cancel'].includes(c.action)){
      const previous=after;await stop('SIGTERM');await boot();after=await get('repeat startup recovery');
      check('AC-8','repeated startup is idempotent with no new work',JSON.stringify(norm(previous))===JSON.stringify(norm(after)),'unchanged persistent data and work',norm(after));
    }
    row.status=row.checks.every(c=>c.ok)?'pass':'fail';
  }catch(error){row.status='incomplete';row.reason=error.message.replaceAll(dir,'<temp>');}
  finally{if(child){await child.stop('SIGKILL');row.mutationLoaded=!!row.mutationLoaded||child.mutationLoaded;}rmSync(dir,{recursive:true,force:true});}
  return row;
}
export async function runRestartCases({mutation,only,childExecutable}={}){
  const selected=CASES.filter(c=>!only||only.includes(c.name));
  if(!selected.length||only&&selected.length!==new Set(only).size)return {completed:false,status:'incomplete',reason:'Unknown or empty scenario selection',scenarios:[]};
  const scenarios=[];for(const c of selected)scenarios.push(await runCase(c,mutation,childExecutable));
  const completed=scenarios.every(s=>s.status!=='incomplete');return {completed,engine:'sequential OS processes / RawAgentRuntime production startup+destroy / SQLite / agent-loop',status:completed?(scenarios.every(s=>s.status==='pass')?'pass':'fail'):'incomplete',scenarios};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const idx=process.argv.indexOf('--config');const config=idx<0?{}:JSON.parse(process.argv[idx+1]);
  const r=await runRestartCases(config);process.stdout.write(JSON.stringify(r));process.exitCode=r.status==='pass'?0:r.status==='fail'?1:2;
}
