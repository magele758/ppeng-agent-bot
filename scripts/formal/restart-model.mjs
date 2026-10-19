/** Bounded durable-state design model, independent of product probes. */
export const SCOPE = {
  checker: 'process-restart-explicit-state/1',
  bounds: { modes: ['chat', 'task'], processGenerations: 3, sequentialRuns: 2, approvals: 2, retries: 1, tools: 2 },
  assumptions: ['Only one live process owns the state directory; each predecessor exits before its successor opens storage.', 'Each completed persistence operation is atomic; crash cuts are at observed await boundaries.', 'Lost in-flight work is interrupted/unknown, not implicitly replayed; unexpired approval pauses are recoverable.', 'External effects without saved results are unconfirmed; no external exactly-once guarantee.'],
  exclusions: ['power loss, corrupt storage or schema migration', 'simultaneous process writers', 'Bot queue and independent scheduler recovery protocols', 'live upstreams, arbitrary tool effects and UI', 'unbounded restarts, retries and approvals'],
};
function initial(mode) { return { mode, generation: 1, alive: true, run: 1, stage: 'model', status: 'running', outcome: null, decisions: [], results: [], effects: [], recovered: false, retryUsed: false }; }
function events(s) {
  if (!s.alive) return s.generation < 3 ? [{ type: 'boot' }] : [];
  const e = s.generation < 3 ? [{ type: 'crash' }, { type: 'graceful' }] : [];
  if (s.stage === 'model') { if(!s.retryUsed)e.push({type:'retry'});e.push({ type: 'approval' }, { type: 'tool' }, { type: 'end' }); }
  if (s.stage === 'retry') e.push({ type: 'tick' });
  if (s.stage === 'tool') { if (!s.effects.includes('b')) e.push({ type: 'effect' }); if (s.effects.includes('b')) e.push({ type: 'save' }); }
  if (s.stage === 'waiting') {
    for (let i=0;i<2;i++) if(s.decisions[i]==='pending') for(const decision of ['approved','rejected']) e.push({type:'decision',i,decision});
    if(s.decisions.every(d=>d!=='pending')) e.push({type:'resume'});
    e.push({type:'cancel'});
  }
  if(s.stage==='ended' && s.run<2 && s.generation>1) e.push({type:'fresh'});
  return e;
}
function step(old,e,fault) {
  let s=structuredClone(old);
  const end=kind=>{s.stage='ended';s.status=kind==='completed'?(s.mode==='task'?'completed':'idle'):'failed';s.outcome=kind;};
  if(e.type==='crash'||e.type==='graceful') { if(e.type==='graceful'&&['model','retry','tool'].includes(s.stage))end('aborted');s.alive=false; }
  if(e.type==='boot') {
    s.alive=true;s.generation++;s.recovered=true;
    if(['model','retry','tool'].includes(s.stage)) { const retry=s.stage==='retry';end('interrupted'); if(fault==='running')s.status='running';if(fault==='retry'&&retry){s.stage='model';s.status='running';} }
    if(s.stage==='waiting'&&fault==='approval')s.decisions=s.decisions.map(()=> 'pending');
  }
  if(e.type==='retry')s.stage='retry';
  if(e.type==='tick'){s.stage='model';s.status='running';s.retryUsed=true;}
  if(e.type==='approval'){s.stage='waiting';s.status='waiting_approval';s.outcome='waiting_approval';s.decisions=['pending','pending'];}
  if(e.type==='decision')s.decisions[e.i]=e.decision;
  if(e.type==='resume'){s.decisions.forEach((d,i)=>{if(d==='approved'&&!s.results.includes(i))s.results.push(i);});end('completed');}
  if(e.type==='tool'){s.stage='tool';s.results=['a'];s.effects=['a'];}
  if(e.type==='effect')s.effects.push('b');
  if(e.type==='save'){s.results.push('b');end('completed');}
  if(e.type==='end')end('completed');
  if(e.type==='cancel'){s.decisions=s.decisions.map(d=>d==='pending'?'rejected':d);end('aborted');}
  if(e.type==='fresh')s={...initial(s.mode),generation:s.generation,run:2,recovered:false};
  return s;
}
function check(s,old,e) {
  const issues=[];
  if(e.type==='boot' && s.stage==='ended' && ['running','waiting_approval'].includes(s.status))issues.push('restart retained phantom active state');
  if(e.type==='boot' && old.stage==='retry' && s.stage!=='ended')issues.push('old retry resurrected');
  if(e.type==='boot' && old.stage==='waiting' && JSON.stringify(old.decisions)!==JSON.stringify(s.decisions))issues.push('approval decisions lost');
  if(e.type==='boot' && old.stage==='ended' && (old.outcome!==s.outcome||old.status!==s.status))issues.push('terminal result rewritten');
  if(new Set(s.results).size!==s.results.length)issues.push('result repeated');
  return {ok:!issues.length,issues,run:s.run,generation:s.generation,status:s.status,outcome:s.outcome};
}
export function replayRestart(trace,{fault}={}) { let s=initial(trace[0].mode),c;for(const e of trace.slice(1)){if(!events(s).some(x=>JSON.stringify(x)===JSON.stringify(e)))throw new Error('Invalid restart replay');const next=step(s,e,fault);c=check(next,s,e);s=next;}return c; }
export function exploreRestartModel({fault,maxStates=100000}={}) {
  const q=SCOPE.bounds.modes.map(mode=>({s:initial(mode),events:[{type:'start',mode}]})),seen=new Set(q.map(r=>JSON.stringify(r.s)));let transitions=0;
  for(let i=0;i<q.length;i++)for(const e of events(q[i].s)){
    transitions++;const s=step(q[i].s,e,fault),c=check(s,q[i].s,e),trace=[...q[i].events,e];
    if(!c.ok)return {status:'fail',exhausted:false,states:seen.size,transitions,counterexample:{events:trace,check:c}};
    const key=JSON.stringify(s);if(!seen.has(key)){if(seen.size>=maxStates)return {status:'incomplete',exhausted:false,states:seen.size,transitions,reason:'state limit'};seen.add(key);q.push({s,events:trace});}
  }
  return {status:'pass',exhausted:true,states:seen.size,transitions};
}
