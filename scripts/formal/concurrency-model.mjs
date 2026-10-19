/** Finite design model, independent of real runtime evidence. No claim of unbounded proof. */
export const SCOPE={checker:'multiprocess-explicit-state/1',bounds:{modes:['chat','task'],concurrentProcesses:2,ownershipGenerations:2,approvals:2,tools:2,claimAttemptsPerProcessPerGeneration:1,lateEventsPerProcessPerGeneration:1},assumptions:['Healthy local SQLite database; committed operations are durable.','At most one authorized writer; valid live ownership is not stolen.','Cancellation/settlement invalidates old execution; late callbacks are fenced.','Unexpired approval decisions are immutable; one executor resumes unfinished allowed work.','External effects without saved results are unconfirmed, not authorization to replay.'],exclusions:['multi-host, network filesystem, partition, corruption, power loss or migration','Bot queues and independent scheduler concurrency protocols','arbitrary process counts, schedules, fairness and external exactly-once','full daemon HTTP draining, UI and live upstream services']};
function initial(mode){return {mode,g:0,owner:-1,holders:[],tokens:[0,0],alive:[true,true],phase:'idle',decisions:[],effects:[],saved:[],attempts:[],late:[],resume:[],cancelled:false};}
function events(s){const e=[];for(let p=0;p<2;p++){
  if(!s.alive[p])continue;
  const key=`${s.g}:${p}`;
  if(s.g<2&&!s.attempts.includes(key))e.push({type:'claim',p});
  if(s.owner===p&&s.phase==='running')e.push({type:'park',p},{type:'finish',p},{type:'cancel',p},{type:'exit',p});
  if(s.phase==='waiting'){
    for(let i=0;i<2;i++)if(s.decisions[i]==='pending')for(const decision of ['approved','rejected'])e.push({type:'decide',p,i,decision});
    if(s.decisions.every(d=>d!=='pending')&&!s.resume.includes(key))e.push({type:'resume',p});
    e.push({type:'cancel',p});
  }
  if(s.tokens[p]&&s.tokens[p]!==s.g&&!s.late.includes(key))e.push({type:'late',p},{type:'release',p});
  if(s.phase==='ended'&&s.decisions.length&&s.decisions.every(d=>d!=='pending')&&!s.resume.includes(key))e.push({type:'resume',p});
}return e;}
function step(old,e,fault){const s=structuredClone(old),key=`${s.g}:${e.p}`;
  const end=()=>{s.phase='ended';s.owner=-1;s.holders=[];};
  if(e.type==='claim'){
    s.attempts.push(key);
    if((s.owner<0&&s.phase!=='waiting')||fault==='ownership'){
      const previous=s.holders;s.g++;s.owner=e.p;s.tokens[e.p]=s.g;s.phase='running';s.holders=fault==='ownership'?[...previous,e.p]:[e.p];s.cancelled=false;s.decisions=[];s.effects=[];s.saved=[];
    }
  }
  if(e.type==='park'){s.phase='waiting';s.decisions=['pending','pending'];}
  if(e.type==='finish'||e.type==='exit'){if(e.type==='exit')s.alive[e.p]=false;end();}
  if(e.type==='cancel'){s.cancelled=true;s.decisions=s.decisions.map(d=>d==='pending'?'rejected':d);end();}
  if(e.type==='decide')s.decisions[e.i]=e.decision;
  if(e.type==='resume'){
    s.resume.push(key);
    if(!s.cancelled&&(s.phase==='waiting'||fault==='approval')){
      for(let i=0;i<2;i++)if(s.decisions[i]==='approved'&&(!s.saved.includes(i)||fault==='approval')){s.effects.push(i);s.saved.push(i);}end();
    }
  }
  if(e.type==='late'||e.type==='release'){s.late.push(key);if(fault==='stale'){s.owner=-1;s.phase='ended';}}
  return s;
}
function check(s,old,e){const issues=[];
  if(s.holders.length>1)issues.push('two authorized writers');
  if(['late','release'].includes(e.type)&&(s.owner!==old.owner||s.phase!==old.phase))issues.push('stale event changed current execution');
  if(new Set(s.effects).size!==s.effects.length)issues.push('approval work executed twice');
  if(s.saved.some(i=>s.decisions[i]!=='approved'))issues.push('unapproved effect');
  if(old.cancelled&&e.type==='resume'&&!s.cancelled)issues.push('cancelled run resumed');
  return {ok:!issues.length,issues,g:s.g,owner:s.owner,phase:s.phase,effects:s.effects};
}
export function replayConcurrency(trace,{fault}={}){let s=initial(trace[0].mode),c;for(const e of trace.slice(1)){if(!events(s).some(x=>JSON.stringify(x)===JSON.stringify(e)))throw new Error('Invalid concurrent replay');const next=step(s,e,fault);c=check(next,s,e);s=next;}return c;}
export function exploreConcurrencyModel({fault,maxStates=100000}={}){
  const q=SCOPE.bounds.modes.map(mode=>({s:initial(mode),events:[{type:'start',mode}]}));const seen=new Set(q.map(x=>JSON.stringify(x.s)));let transitions=0;
  for(let n=0;n<q.length;n++)for(const e of events(q[n].s)){
    transitions++;const next=step(q[n].s,e,fault),c=check(next,q[n].s,e),trace=[...q[n].events,e];
    if(!c.ok)return {status:'fail',exhausted:false,states:seen.size,transitions,counterexample:{events:trace,check:c}};
    const key=JSON.stringify(next);if(!seen.has(key)){if(seen.size>=maxStates)return {status:'incomplete',exhausted:false,states:seen.size,transitions,reason:'state limit'};seen.add(key);q.push({s:next,events:trace});}
  }
  return {status:'pass',exhausted:true,states:seen.size,transitions};
}
