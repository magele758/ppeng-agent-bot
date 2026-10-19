import{mkdtempSync,mkdirSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{CASES}from'./concurrency-cases.mjs';
import{service}from'./concurrency-process.mjs';
const parts=s=>s.messages.flatMap(m=>m.parts);
const tools=s=>s.ledger.filter(e=>e.sid===s.sid&&e.kind==='tool').map(e=>e.id);
const models=s=>s.ledger.filter(e=>e.sid===s.sid&&e.kind==='model');
const continuations=s=>parts(s).filter(p=>p.type==='text'&&/^Approval for .* Continue\.$/.test(p.text)).length;
function paired(ps,closed=true){const seen=new Map();for(const p of ps){if(p.type==='tool_call'){if(seen.has(p.toolCallId))return false;seen.set(p.toolCallId,0);}if(p.type==='tool_result'){if(!seen.has(p.toolCallId)||seen.get(p.toolCallId))return false;seen.set(p.toolCallId,1);}}return !closed||[...seen.values()].every(Boolean);}
const outcome=s=>({status:s.status,outcome:s.outcome?{kind:s.outcome.kind,reason:s.outcome.reason}:null,writer:s.writer,interrupt:s.interrupt});
async function scenario(c,options){
  const dir=mkdtempSync(join(tmpdir(),'concurrency-runtime-'));mkdirSync(join(dir,'repo'));
  const row={name:c.name,mode:c.mode,status:'incomplete',overlapConfirmed:false,processes:[],events:[],snapshots:[],checks:[]};
  const live=[],ids=new Map();let sid;
  const seedApprovalIds=value=>{
    if(Array.isArray(value)){for(const v of value)seedApprovalIds(v);return;}
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value.approvals))for(const a of value.approvals)if(a.id&&!ids.has(a.id))ids.set(a.id,`approval-${a.tool}`);
    for(const v of Object.values(value))seedApprovalIds(v);
  };
  const normalize=(value,root=true)=>{
    if(root)seedApprovalIds(value);
    if(typeof value==='string')return value.replaceAll(dir,'<temp>').replace(/\b(?:session|run|approval|msg)_[a-f0-9]+\b/g,id=>{if(!ids.has(id))ids.set(id,`${id.split('_')[0]}-${ids.size+1}`);return ids.get(id);}).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:[\d.Z]+/g,'<time>').replace(/ at [^\n]+/g,' at <source>');
    if(Array.isArray(value))return value.map(v=>normalize(v,false));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['createdAt','updatedAt','ts'].includes(k)).map(([k,v])=>[k,k==='approvalIds'?v.map(id=>normalize(id,false)).sort():normalize(v,false)]));
    return value;
  };
  const check=(criterion,label,ok,expected,actual)=>row.checks.push({criterion,label,ok:!!ok,expected:normalize(expected),actual:normalize(actual)});
  const snap=(label,s)=>{row.events.push(label);row.snapshots.push({event:label,...normalize(s)});return s;};
  const rpc=async(p,command,args)=>{row.events.push(`${p.name}: ${command}`);return p.rpc(command,args);};
  const boot=async name=>{const p=await service({dir,process:name,sid},options);live.push(p);row.processes.push({process:name,distinctPid:live.every(x=>x===p||x.pid!==p.pid)});row.events.push(`${name}: runtime ready`);return p;};
  const view=async(p,label)=>snap(label,await rpc(p,'snapshot'));
  const start=async(p,phase='model',holdTool=false)=>{const r=await rpc(p,'start',{phase,holdTool});snap(`${p.name}: ${r.stage??'settled'}`,r.snapshot);return r;};
  const finish=async p=>{const r=await rpc(p,'finish');snap(`${p.name}: finish${r.error?' rejected':''}`,r.snapshot);return r;};
  const decide=async(p,index,decision)=>{const r=await rpc(p,'decide',{index,decision});snap(`${p.name}: ${decision} ${index}${r.error?' rejected':''}`,r.snapshot);return r;};
  const atomicClaimRace=async(a,b,criterion)=>{
    const baseModels=models(await rpc(a,'snapshot')).length;
    await rpc(a,'cuts',{'before-claim':1});await rpc(b,'cuts',{'before-claim':1});
    const pa=rpc(a,'start',{phase:'model'});pa.catch(()=>{});const ca=await a.cut('before-claim');row.events.push(`${a.name}: observed before-claim`);
    const pb=rpc(b,'start',{phase:'model'});pb.catch(()=>{});const cb=await b.cut('before-claim');row.events.push(`${b.name}: observed before-claim`);
    const reverse=c.kind.endsWith('-B');const first=reverse?b:a,second=reverse?a:b;
    first.proceed(reverse?cb:ca);row.events.push(`${first.name}: claim proceeds`);const winner=await (reverse?pb:pa);snap('first contender returned',winner.snapshot);
    second.proceed(reverse?ca:cb);row.events.push(`${second.name}: claim proceeds`);const loser=await (reverse?pa:pb);snap('second contender returned',loser.snapshot);
    check(criterion,'one contender starts and other explicitly conflicts without changing owner',!!winner.stage&&!loser.stage&&/busy|conflict|writer|running/i.test(loser.error??'')&&loser.snapshot.writer===winner.snapshot.writer&&models(loser.snapshot).length===baseModels+1,'one model entry, explicit conflict, unchanged owner',{winner,loser});
    if(loser.stage)await finish(second);await finish(first);
  };
  try{
    const A=await boot('A');const initial=await rpc(A,'create',{mode:c.mode});sid=initial.sid;snap('session created',initial);
    // Initialize every competitor before race; boot-live deliberately opens B after active work.
    let B;
    if((c.kind.startsWith('boot-live')&&c.kind!=='boot-live-peer')||c.kind.startsWith('contend')){
      const phase=c.kind.split('-').at(-1);const old=await start(A,phase,phase==='tool');B=await boot('B');
      const [a,b]=await Promise.all([rpc(A,'ping'),rpc(B,'ping')]);row.overlapConfirmed=a.pid!==b.pid;
      const after=await view(B,'competitor startup read');
      check('AC-2','startup preserves live owner and does not automatically duplicate work',JSON.stringify(outcome(old.snapshot))===JSON.stringify(outcome(after))&&models(after).length===models(old.snapshot).length,'live state and work unchanged',after);
      if(c.kind.startsWith('contend')){
        const other=await start(B);check('AC-2','explicit competitor cannot take live owner',!!other.error&&!other.stage&&other.snapshot.writer===old.snapshot.writer&&models(other.snapshot).length===models(old.snapshot).length,'explicit conflict and same owner',other);
        if(other.stage)await finish(B);
      }
      await finish(A);
    }else{
      B=await boot('B');const [a,b]=await Promise.all([rpc(A,'ping'),rpc(B,'ping')]);row.overlapConfirmed=a.pid!==b.pid;
      if(options.failBarrier)await B.cut('unreachable-phase',50);
      if(c.kind==='boot-live-peer'){
        const old=await start(B);await A.stop();row.events.push('A: boot owner exited while B keeps executing');const C=await boot('C');const after=await view(C,'new boot owner observes live peer');
        check('AC-2','new boot owner does not recover a live peer writer',JSON.stringify(outcome(old.snapshot))===JSON.stringify(outcome(after))&&models(after).length===models(old.snapshot).length,'peer owner and work unchanged',after);await finish(B);
      }else if(c.kind.startsWith('claim'))await atomicClaimRace(A,B,'AC-1');
      else if(c.kind==='handoff-peer-crash'){
        const old=await start(B);await B.stop();row.events.push('B: non-boot writer exit confirmed; A boot owner remains live');const C=await boot('C');
        const next=await start(C,'complete');
        check('AC-4','dead peer claim does not block legal fresh work while another boot owner lives',next.settled&&!next.error&&!next.snapshot.writer&&!['running','waiting_approval'].includes(next.snapshot.status)&&models(next.snapshot).filter(m=>m.process==='C').length===1&&models(next.snapshot).filter(m=>m.process==='B').length===models(old.snapshot).filter(m=>m.process==='B').length,'one fresh request; no old peer replay',next);
      }else if(c.kind.startsWith('handoff')){
        await start(A);
        if(c.kind.includes('crash')){await A.stop();row.events.push('A: confirmed SIGKILL exit');const C=await boot('C');await atomicClaimRace(B,C,'AC-4');}
        else{await finish(A);await atomicClaimRace(A,B,'AC-4');}
      }else if(c.kind==='release-race'){
        await start(A);await rpc(A,'cuts',{'after-release-read':1});
        const old=rpc(A,'finish');old.catch(()=>{});const cut=await A.cut('after-release-read');row.events.push('A: terminal run read its claim before release');
        const contender=await start(B);const before=await view(B,'successor before old release resumes');A.proceed(cut);await old;
        const after=await view(B,'successor after old release resumes');
        check('AC-3','release based on an old read cannot clear a newer claim',contender.stage ? JSON.stringify(outcome(before))===JSON.stringify(outcome(after)) : /writer|busy|conflict/i.test(contender.error??'')&&!after.writer&&!['running','waiting_approval'].includes(after.status),'new owner unchanged, or contender explicitly blocked until old owner finishes',{contender,before,after});
        if(contender.stage)await finish(B);else{const next=await start(B,'complete');check('AC-4','successor proceeds once old release completes',next.settled&&!next.error,'new run completes',next);}
      }else if(c.kind.startsWith('stale')||c.kind==='release-control'){
        const phase=c.kind==='stale-partial-tools'?'partial-tools':c.kind==='stale-tool'?'tool':'model';const old=await start(A,phase,phase!=='model');
        if(c.kind==='stale-partial-tools'&&!parts(old.snapshot).some(p=>p.type==='tool_result'&&p.toolCallId==='a'&&p.ok))throw new Error('Missing saved result precondition');
        await rpc(A,'cancel');row.events.push('A: old run cancellation accepted, I/O still held');
        const current=await start(B);const before=await view(B,'new owner before stale release');
        const released=snap('stale explicit release',await rpc(A,'release',old.snapshot.writer));
        check('AC-3','stale release retains current writer and state',JSON.stringify(outcome(before))===JSON.stringify(outcome(released)),'unchanged current owner and outcome',released);
        if(c.kind!=='release-control'){
          const append=await rpc(A,'append',old.snapshot.writer);snap('stale explicit append',append.snapshot);
          check('AC-5','old explicit append rejected with identifiable conflict',!append.accepted&&/writer|claim/i.test(append.error??'')&&!parts(append.snapshot).some(p=>p.text==='stale-explicit-write'),'writer conflict without added message',append);
          const late=await finish(A);const after=await view(B,'new owner after old I/O returned');
          const trace=await rpc(A,'trace');check('AC-5','actual old callback rejection is observable in the trace',trace.some(e=>e.kind==='stale_writer_rejected'),'stale writer trace',trace.filter(e=>e.kind==='stale_writer_rejected'));
          check('AC-5','late kernel completion cannot alter new state or append old content',JSON.stringify(outcome(before))===JSON.stringify(outcome(after))&&JSON.stringify(parts(before))===JSON.stringify(parts(after))&&!parts(after).some(p=>p.type==='text'&&p.text==='done-A-run-1')&&models(after).filter(e=>e.process==='A').length===models(before).filter(e=>e.process==='A').length,'current state preserved; old completion rejected', {late,after});
          check('AC-3','late kernel finally does not alter current ownership or outcome',JSON.stringify(outcome(before))===JSON.stringify(outcome(after)),'unchanged',after);
          const cancelled=snap('old caller late cancellation',await rpc(A,'cancel',old.snapshot.writer));
          check('AC-3','late old cancellation cannot cancel another process run',JSON.stringify(outcome(after))===JSON.stringify(outcome(cancelled)),'unchanged current run',cancelled);
        }
        if(current.stage)await finish(B);
        const end=await view(B,'history after stale path');
        if(c.kind==='stale-partial-tools')check('AC-10','saved a is retained once and unconfirmed b is not replayed; new model sees a closed wave',parts(end).filter(p=>p.type==='tool_result'&&p.toolCallId==='a'&&p.ok&&p.content==='result-a').length===1&&!parts(end).some(p=>p.type==='tool_result'&&p.toolCallId==='b'&&p.ok)&&JSON.stringify(tools(end))===JSON.stringify(['a','b'])&&models(end).filter(m=>m.process==='B').every(m=>paired(m.parts)),'saved a once; interrupted b once; paired new model input',end);
        const seq=end.messages.map(m=>m.seq);
        check('AC-10','history sequence is unique and saved tool results are not duplicated',new Set(seq).size===seq.length&&seq.every((n,i)=>i===0||n>seq[i-1])&&paired(parts(end)),'strict sequence and paired results',end);
      }else if(c.kind==='independent'){
        await start(A);const competing=await start(B);if(competing.stage)await finish(B);
        const second=await rpc(B,'create',{mode:c.mode});const independent=await start(B,'complete');
        check('AC-11','unrelated session completes with its own clean history',independent.settled&&!independent.error&&independent.snapshot.sid===second.sid&&!independent.snapshot.writer&&independent.snapshot.outcome?.kind===(c.mode==='task'?'completed':'idle')&&independent.snapshot.approvals.length===0,'independent completed run',independent);
        await finish(A);
      }else{
        const prepared=await start(A,'approval',false);if(prepared.snapshot.status!=='waiting_approval'||prepared.snapshot.approvals.length!==2)throw new Error('Approval phase not observed');
        if(c.kind.startsWith('approval-decision')){
          await rpc(A,'cuts',{'before-decision-write':1});await rpc(B,'cuts',{'before-decision-write':1});
          const pa=rpc(A,'decide',{index:0,decision:'approved'});pa.catch(()=>{});const ca=await A.cut('before-decision-write');
          const pb=rpc(B,'decide',{index:0,decision:c.kind.endsWith('opposed')?'rejected':'approved'});pb.catch(()=>{});const cb=await B.cut('before-decision-write');
          row.events.push('A and B both observed pending before decision write');A.proceed(ca);const da=await pa;B.proceed(cb);const db=await pb;const end=await view(A,'concurrent approval decisions read back');
          check('AC-6','one immutable decision and consistent responses',!da.error&&!db.error&&da.decision==='approved'&&db.decision==='approved'&&end.approvals[0].status==='approved'&&end.approvals[1].status==='pending'&&continuations(end)===0,'approved retained; no duplicate continuation',{da,db,end});
        }else if(c.kind==='approval-partial'){
          const d=await decide(A,0,'approved');const r=await start(B,'resume');const end=r.snapshot;
          check('AC-7','partial decision preserved without resumed execution or duplicate approval',!d.error&&!r.error&&end.status==='waiting_approval'&&end.outcome?.kind==='waiting_approval'&&end.approvals.length===2&&end.approvals[0].status==='approved'&&end.approvals[1].status==='pending'&&tools(end).length===0&&models(end).length===1,'one approved, one pending, still waiting',end);
        }else if(c.kind==='approval-final-control'||c.kind==='approval-final-foreign'){
          await decide(A,0,'approved');const decider=c.kind==='approval-final-control'?A:B;
          let d;
          if(c.kind==='approval-final-foreign'){
            await rpc(A,'cuts',{'before-decision-write':1});await rpc(B,'cuts',{'before-decision-write':1});
            const pa=rpc(A,'decide',{index:1,decision:'approved'});pa.catch(()=>{});const ca=await A.cut('before-decision-write');
            const pb=rpc(B,'decide',{index:1,decision:'approved'});pb.catch(()=>{});const cb=await B.cut('before-decision-write');
            row.events.push('two final-decision requests both observed pending; B commits first');B.proceed(cb);d=await pb;A.proceed(ca);const other=await pa;
            snap('concurrent owner decision returned',other.snapshot);
            check('AC-6','both final decision responses agree without continuation failure',!d.error&&!other.error&&d.decision===other.decision,'one durable decision; no partially failed response',{d,other});
          }else d=await decide(decider,1,'approved');
          const repeat=await decide(decider,1,'approved');
          check('AC-6','final decision is idempotent with one continuation',!d.error&&!repeat.error&&continuations(repeat.snapshot)===1&&repeat.snapshot.approvals.every(a=>a.status==='approved'),'one continuation; both decisions saved',{d,repeat});
          if(c.kind==='approval-final-foreign')check('AC-8','foreign last decider leaves a coherent resumable checkpoint',!d.error&&d.snapshot.status==='idle'&&!!d.snapshot.interrupt,'last decision accepted without writer conflict',d);
        }else if(c.kind.startsWith('approval-resume')){
          const decisions=c.kind.endsWith('rejected')?['rejected','rejected']:c.kind.endsWith('mixed')?['approved','rejected']:['approved','approved'];
          for(let i=0;i<2;i++)await decide(A,i,decisions[i]);
          await rpc(A,'cuts',{'before-claim':1});await rpc(B,'cuts',{'before-claim':1});
          const pa=rpc(A,'start',{phase:'resume',holdTool:true});pa.catch(()=>{});const ca=await A.cut('before-claim');
          const pb=rpc(B,'start',{phase:'resume',holdTool:true});pb.catch(()=>{});const cb=await B.cut('before-claim');
          row.events.push('two resume requests captured same durable interrupt');A.proceed(ca);const ra=await pa;B.proceed(cb);const rb=await pb;snap('second resume returned',rb.snapshot);
          if(rb.stage)await finish(B);if(ra.stage)await finish(A);
          const end=await view(A,'both resume requests finished');const expected=decisions.map((d,i)=>d==='approved'?['a','b'][i]:null).filter(Boolean);
          check('AC-8','single executor resumes permitted unfinished tools once',JSON.stringify(tools(end))===JSON.stringify(expected)&&!end.interrupt&&!['running','waiting_approval'].includes(end.status)&&!end.writer,'allowed tools once, wait and claim cleared',{expected,work:tools(end),end});
          check('AC-10','resumed tool history and prepared model views are paired',paired(parts(end))&&models(end).every(m=>paired(m.parts))&&['a','b'].every(id=>parts(end).filter(p=>p.type==='tool_result'&&p.toolCallId===id).length===1),'one result per call, paired model views',end);
        }else if(['cancel-first','decision-first','resume-first'].includes(c.kind)){
          if(c.kind!=='cancel-first'){await decide(A,0,'approved');await decide(A,1,'approved');}
          let running;if(c.kind==='resume-first')running=await start(A,'resume',true);
          const cancelled=snap('cancellation effective',await rpc(A,'cancel'));const count=tools(cancelled).length;
          await decide(B,0,'approved');await decide(B,1,'approved');
          if(running?.stage)await finish(A);
          const late=await rpc(B,'recoverApproval',{index:1});snap('production approval recovery predicate applied',late.snapshot);if(late.stage)await finish(B);const end=await view(B,'late old approval recovery');
          check('AC-9','cancel cannot be undone by old decision/resume',end.outcome?.kind==='aborted'&&!end.interrupt&&tools(end).length===count&&models(end).length===models(cancelled).length,'cancelled; no work started after cancel',{late,end});
          const fresh=await rpc(B,'fresh');snap('explicit new input completed',fresh.snapshot);const repeat=await rpc(B,'recoverApproval',{index:1});
          check('AC-9','explicit fresh input works while old approvals remain fenced',fresh.settled&&!fresh.error&&models(fresh.snapshot).length===models(end).length+1&&JSON.stringify(tools(fresh.snapshot))===JSON.stringify(tools(end))&&repeat.skipped&&JSON.stringify(outcome(repeat.snapshot))===JSON.stringify(outcome(fresh.snapshot)),'one explicit new request; old approval does not revive',{fresh,repeat});
        }else throw new Error('Unhandled case '+c.kind);
      }
    }
    row.mutationLoaded=live.some(p=>p.mutationLoaded);row.status=row.checks.every(x=>x.ok)?'pass':'fail';
  }catch(error){row.reason=normalize(String(error.stack));row.status='incomplete';}
  finally{for(const p of live){await p.stop();row.events.push(`${p.name}: exit confirmed`);}rmSync(dir,{recursive:true,force:true});}
  return row;
}
export async function runConcurrencyRuntime(options={}){
  const selected=CASES.filter(c=>!options.only||options.only.includes(c.name));
  if(!selected.length)return {completed:false,status:'incomplete',reason:'No selected scenarios',scenarios:[]};
  const scenarios=[];for(const c of selected){const row=await scenario(c,options);scenarios.push(row);if(row.status==='incomplete')break;}
  const completed=scenarios.length===selected.length&&scenarios.every(s=>s.status!=='incomplete');
  return {completed,status:!completed?'incomplete':scenarios.every(s=>s.status==='pass')?'pass':'fail',scenarios};
}
if(process.argv.includes('--config')){try{const r=await runConcurrencyRuntime(JSON.parse(process.argv[process.argv.indexOf('--config')+1]));process.stdout.write(JSON.stringify(r));process.exitCode=r.status==='pass'?0:r.status==='fail'?1:2;}catch(e){process.stdout.write(JSON.stringify({completed:false,status:'incomplete',reason:String(e.stack),scenarios:[]}));process.exitCode=2;}}
