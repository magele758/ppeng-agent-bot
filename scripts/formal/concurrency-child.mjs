/** Real runtime and storage. Only upstream/tool I/O and observation barriers are controlled. */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
for(const key of ['log','info','debug'])console[key]=(...args)=>console.error(...args);
process.env.RAW_AGENT_MODEL_MAX_RETRIES='1';
process.env.RAW_AGENT_AGENTS_SKILLS='0';
const config=JSON.parse(process.argv[2]);
let cuts={},cutSequence=0;
const sleeper=new Int32Array(new SharedArrayBuffer(4));
globalThis.__concurrencyCut=(name)=>{
  if(!cuts[name])return;
  cuts[name]--;
  const token=`${config.process}-${++cutSequence}`;
  process.send?.({cut:name,token});
  const deadline=Date.now()+15000;
  while(!existsSync(join(config.dir,token))){if(Date.now()>deadline)throw new Error(`OBSERVATION_BARRIER_TIMEOUT:${name}`);Atomics.wait(sleeper,0,0,4);}
};
const {RawAgentRuntime}=await import('../../packages/core/dist/exports/public.js');
const {shouldResumeAfterApproval}=await import('../../apps/daemon/dist/routes/misc.js');
let sid=config.sid, active, run={phase:"complete",number:0,calls:0,releases:[],enter:()=>{}}, nextRun=0;
const ledger=event=>appendFileSync(join(config.dir,'ledger.jsonl'),JSON.stringify({process:config.process,...event})+'\n');
function gate(r){return new Promise(resolve=>r.releases.push(resolve));}
function entered(r,stage){r.enter(stage);}
const originalTimer=globalThis.setTimeout;
globalThis.setTimeout=(fn,delay,...args)=>{
  const r=run;
  if(delay===2000&&r?.phase==='retry'){
    const timer=originalTimer(()=>{if(r.finishing)fn(...args);else gate(r).then(()=>fn(...args));},delay);
    entered(r,'retry-timer-registered');return timer;
  }
  return originalTimer(fn,delay,...args);
};
const text=r=>({stopReason:'end',assistantParts:[{type:'text',text:`done-${config.process}-run-${r.number}`}]});
const runtime=new RawAgentRuntime({repoRoot:join(config.dir,'repo'),stateDir:join(config.dir,'state'),maxParallelToolCalls:1,
  modelAdapter:{name:'concurrency-controlled',summarizeMessages:async()=>'',completeText:async()=>'{"met":true,"reason":"probe"}',
    async runTurn(input){const r=run;r.calls++;ledger({kind:'model',sid,run:r.number,call:r.calls,parts:input.messages.flatMap(m=>m.parts??[]).filter(p=>['tool_call','tool_result'].includes(p.type))});
      if(r.phase==='retry'&&r.calls===1)throw new Error('controlled retryable error');
      if((['tool','approval','approval-one'].includes(r.phase)&&r.calls===1)||(r.phase==='partial-tools'&&r.calls<=2))return {stopReason:'tool_use',assistantParts:(r.phase==='partial-tools'?[r.calls===1?'a':'b']:r.phase==='approval-one'||r.phase==='tool'?['b']:['a','b']).map(id=>({type:'tool_call',toolCallId:id,name:`concurrency_${id}`,input:{token:id}}))};
      if(r.phase==='model'){entered(r,'model-entered');await gate(r);}
      return text(r);
    }},extraTools:['a','b'].map(id=>({name:`concurrency_${id}`,description:'Hermetic concurrency probe',inputSchema:{type:'object'},approvalMode:'never',sideEffectLevel:'none',
      async execute(){const r=run;ledger({kind:'tool',sid,run:r.number,id});
        if(r.holdTool&&(r.phase!=='partial-tools'||id==='b')){entered(r,`tool-${id}-entered`);await gate(r);}
        return {ok:true,content:`result-${id}`};
      }}))});
// Approval policy is configured through the existing tool specification, not store state.
// The registry stores the provided tool objects; per-scenario approval is chosen before execution.
function approvalPolicy(approval){for(const name of ['concurrency_a','concurrency_b']){const tool=runtime.tools.find(tool=>tool.name===name);if(tool)tool.approvalMode=approval?'always':'never';}}
function snapshot(){const s=runtime.getSession(sid);return {sid,status:s.status,outcome:s.metadata?.outcome??null,interrupt:s.metadata?.interrupt??null,writer:s.activeWriterRunId??null,
  approvals:runtime.listApprovals().filter(a=>a.sessionId===sid).sort((a,b)=>a.toolName.localeCompare(b.toolName)).map(a=>({id:a.id,tool:a.toolName,status:a.status,args:a.args})),
  messages:runtime.getSessionMessages(sid),fold:runtime.store.foldMessages(sid),
  ledger:(()=>{try{return readFileSync(join(config.dir,'ledger.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}})()};}
async function start(args={}){
  const r={...args,number:++nextRun,calls:0,releases:[]};run=r;approvalPolicy(args.phase?.startsWith('approval')||args.phase==='resume');
  let enter;const reached=new Promise(resolve=>enter=resolve);r.enter=enter;
  active=runtime.runSession(sid).then(()=>({settled:true}),error=>({settled:true,error:String(error.stack)}));
  const stage=await Promise.race([reached.then(stage=>({stage})),active]);
  return {...stage,snapshot:snapshot()};
}
process.on('message',async({id,command,args})=>{try{let value;
  if(command==='create'){const input={title:'concurrency verification',message:'controlled local work',background:false};sid=args.mode==='task'?runtime.createTaskSession(input).session.id:runtime.createChatSession(input).id;value=snapshot();}
  else if(command==='select'){sid=args;value=snapshot();}
  else if(command==='snapshot')value=snapshot();
  else if(command==='cuts'){cuts=args;value=true;}
  else if(command==='start')value=await start(args);
  else if(command==='fresh'){runtime.sendUserMessage(sid,'explicit fresh work after cancellation');value=await start({phase:'complete'});}
  else if(command==='trace')value=await runtime.listTraceEvents(sid);
  else if(command==='recoverApproval'){const a=runtime.listApprovals().filter(a=>a.sessionId===sid).sort((a,b)=>a.toolName.localeCompare(b.toolName))[args.index];const s=runtime.getSession(sid);const pending=runtime.listApprovals('pending').some(a=>a.sessionId===sid);value=shouldResumeAfterApproval(a.status,s.status,pending,s.metadata)?await start({phase:'resume'}):{settled:true,skipped:true,snapshot:snapshot()};}
  else if(command==='finish'){run.finishing=true;run.holdTool=false;for(const release of run?.releases.splice(0)??[])release();value={...await active,snapshot:snapshot()};}
  else if(command==='cancel'){runtime.cancelSession(sid,args?{expectedWriterRunId:args}:undefined);value=snapshot();}
  else if(command==='release'){runtime.store.releaseWriter(sid,args);value=snapshot();}
  else if(command==='append'){try{runtime.store.appendMessage(sid,'assistant',[{type:'text',text:'stale-explicit-write'}],{expectedWriterRunId:args});value={accepted:true};}catch(error){value={accepted:false,error:String(error)};}value.snapshot=snapshot();}
  else if(command==='decide'){const a=runtime.listApprovals().filter(a=>a.sessionId===sid).sort((a,b)=>a.toolName.localeCompare(b.toolName))[args.index];try{const decided=await runtime.approve(a.id,args.decision);value={decision:decided.status};}catch(error){value={error:String(error)};}value.snapshot=snapshot();}
  else if(command==='ping')value={pid:process.pid};
  else throw new Error('Unknown command '+command);
  process.send?.({id,value});
}catch(error){process.send?.({id,error:String(error.stack)});}});
process.on('disconnect',()=>process.exit(0));
process.send?.({ready:true,pid:process.pid});
