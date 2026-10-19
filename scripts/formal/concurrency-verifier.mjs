import{readFileSync}from'node:fs';
import{dirname,join,resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{createHash}from'node:crypto';
import{spawnSync}from'node:child_process';
import{sanitizeScriptEnv}from'../spawn-utils.mjs';
import{withVerificationEvidence}from'../ci/verification-evidence.mjs';
import{CASES}from'./concurrency-cases.mjs';
import{MUTATIONS}from'./concurrency-mutations.mjs';
export{SCOPE,exploreConcurrencyModel,replayConcurrency}from'./concurrency-model.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=s=>createHash('sha256').update(s).digest('hex');
const env=()=>sanitizeScriptEnv({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,CI_VERIFICATION_EVIDENCE_DIR:process.env.CI_VERIFICATION_EVIDENCE_DIR,CI_VERIFICATION_RUN_ID:process.env.CI_VERIFICATION_RUN_ID});
let built=false;
function build(){if(built)return;if(JSON.parse(readFileSync(join(ROOT,'node_modules/typescript/package.json'))).version!=='5.9.3')throw new Error('TypeScript 5.9.3 required; npm ci');const r=spawnSync(process.execPath,[join(ROOT,'node_modules/typescript/bin/tsc'),'-b','apps/daemon'],{cwd:ROOT,env:env(),encoding:'utf8',timeout:60000,maxBuffer:4e6});if(r.error||r.status!==0)throw new Error('Fresh core build failed: '+(r.error?.message??r.stdout+r.stderr));built=true;}
function execute(executable,args,timeoutMs,ownGroup=true){const r=spawnSync(executable,args,{cwd:ROOT,env:env(),encoding:'utf8',timeout:timeoutMs,killSignal:ownGroup?'SIGKILL':'SIGTERM',detached:ownGroup&&process.platform!=='win32',maxBuffer:50e6});if((r.error||r.signal)&&ownGroup){if(r.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(r.pid),'/T','/F'],{env:env(),timeout:5000,stdio:'ignore'});else try{process.kill(-r.pid,'SIGKILL');}catch{}}}return r;}
export async function verifyConcurrencyRuntime(options={}){
  build();
  return withVerificationEvidence({root:ROOT,kind:'concurrency-runtime',options,environment:env(),validate:r=>r.completed===true&&JSON.stringify(r.scenarios?.map(s=>s.name))===JSON.stringify(CASES.map(c=>c.name))&&r.scenarios.every(s=>s.status==='pass'&&s.overlapConfirmed&&s.processes?.length>=2&&s.processes.every(p=>p.distinctPid)&&s.events?.length&&s.snapshots?.length&&s.checks?.length&&s.checks.every(c=>c.ok===true&&/^AC-(?:[1-9]|1[01])$/.test(c.criterion)))},()=>executeConcurrencyRuntime(options));
}
async function executeConcurrencyRuntime({mutation,only,childExecutable,failBarrier,executable=process.execPath}={}){
  // The full matrix starts over 120 real processes; hosted runners need more than four minutes.
  // Per-process readiness, RPC and barrier deadlines remain enforced by concurrency-process.
  build();const r=execute(executable,[join(ROOT,'scripts/formal/concurrency-runtime.mjs'),'--config',JSON.stringify({mutation,only,childExecutable,failBarrier})],600000,false);
  if(r.error||r.signal)return {completed:false,status:'incomplete',reason:r.error?.message??r.signal,scenarios:[]};
  try{const report=JSON.parse(r.stdout);if(!report.scenarios?.length)throw new Error('Missing real scenarios');
    if(report.completed){const expected=CASES.filter(c=>!only||only.includes(c.name)).map(c=>c.name);if(JSON.stringify(report.scenarios.map(s=>s.name))!==JSON.stringify(expected)||report.scenarios.some(s=>!s.overlapConfirmed||s.processes.length<2||s.processes.some(p=>!p.distinctPid)||!s.events.length||!s.snapshots.length||!s.checks.length||s.checks.some(c=>typeof c.ok!=='boolean'||!/^AC-(?:[1-9]|1[01])$/.test(c.criterion))))throw new Error('Missing process/barrier/check evidence');
      const status=report.scenarios.every(s=>s.status==='pass'&&s.checks.every(c=>c.ok))?'pass':'fail';
      if(report.status!==status||report.scenarios.some(s=>s.status!==(s.checks.every(c=>c.ok)?'pass':'fail'))||r.status!==(status==='pass'?0:1))throw new Error('Runtime exit/status/check mismatch');
    }else if(report.status!=='incomplete'||r.status!==2)throw new Error('Incomplete runtime misreported');return report;
  }catch(e){return {completed:false,status:'incomplete',reason:e.message+'; '+r.stderr.slice(-1200),scenarios:[]};}
}
export async function verifyConcurrencyMutations(){
  build();
  return withVerificationEvidence({root:ROOT,kind:'concurrency-mutations',environment:env(),validate:r=>r.restored===true&&r.baselineStatus==='pass'&&JSON.stringify(r.mutants?.map(m=>m.name))===JSON.stringify(Object.keys(MUTATIONS))&&r.mutants.every(m=>m.loaded&&m.killed&&m.sourceUnchanged&&m.before!==m.after&&m.counterexample?.status==='fail')},()=>executeConcurrencyMutations());
}
async function executeConcurrencyMutations(){
  const only=Object.values(MUTATIONS).flatMap(m=>m.cases),baseline=await verifyConcurrencyRuntime({only}),mutants=[];
  if(!baseline.completed)throw new Error('Incomplete mutation baseline '+JSON.stringify(baseline));
  for(const[name,m]of Object.entries(MUTATIONS)){
    const source=readFileSync(join(ROOT,m.file),'utf8');if(source.split(m.from).length!==2)throw new Error('Mutation anchor drift: '+name);
    const changed=await verifyConcurrencyRuntime({only:m.cases,mutation:name});
    const counterexample=changed.scenarios.find(s=>s.status==='fail'&&baseline.scenarios.find(b=>b.name===s.name)?.status==='pass');
    const loaded=changed.scenarios.some(s=>s.mutationLoaded);
    mutants.push({name,file:m.file,before:sha(source),after:sha(source.replace(m.from,m.to)),sourceUnchanged:sha(readFileSync(join(ROOT,m.file),'utf8'))===sha(source),loaded,killed:changed.completed&&loaded&&!!counterexample,counterexample,executionStatus:changed.status,reason:changed.reason??changed.scenarios.find(s=>s.reason)?.reason});
  }
  const restored=JSON.stringify(baseline)===JSON.stringify(await verifyConcurrencyRuntime({only}));
  return {status:restored&&mutants.every(m=>m.killed&&m.sourceUnchanged)?'pass':'fail',baselineStatus:baseline.status,baseline,restored,mutants};
}
export function checkConcurrencyReview({read=p=>readFileSync(p,'utf8')}={}){
  const manifest=JSON.parse(readFileSync(join(ROOT,'specs/formal/concurrency-review.json')));
  const changed=[...new Set([...manifest.mapping.flatMap(m=>m.files),...Object.keys(manifest.sha256)])].filter(p=>{try{return sha(read(join(ROOT,p)))!==manifest.sha256[p];}catch{return true;}});
  return {status:changed.length?'needs-review':'reviewed',changed,mapping:manifest.mapping};
}
export function concurrencyVerdict(r){
  if(r.model?.status==='incomplete'||!r.runtime?.completed||Object.values(r.existing??{}).some(e=>e?.status==='incomplete'))return 'incomplete';
  return r.model?.status==='pass'&&r.model.exhausted&&r.runtime.status==='pass'&&r.mutations?.status==='pass'&&r.mutations.restored&&r.review?.status==='reviewed'&&['restart','lifecycle','pairing'].every(k=>r.existing?.[k]?.status==='pass')?'pass':'fail';
}
export function runConcurrencyProcess({executable=process.execPath,worker=join(ROOT,'scripts/formal/concurrency-worker.mjs'),timeoutMs=900000}={}){
  const r=execute(executable,[worker],timeoutMs);
  if(r.error||r.signal)return {status:'incomplete',exitCode:2,reason:r.error?.message??r.signal};
  try{const report=JSON.parse(r.stdout);if(report.schema!==1||!['pass','fail','incomplete'].includes(report.status))throw new Error('Invalid report');if(report.status!=='incomplete'&&(!report.model||!report.runtime||!report.mutations||!report.review||!report.existing||report.negativeControls?.length!==3))throw new Error('Missing verification stages');if(report.status==='pass'&&(concurrencyVerdict(report)!=='pass'||report.negativeControls.some(n=>n.result.status!=='fail')))throw new Error('False success report');const exitCode=report.status==='pass'?0:report.status==='fail'?1:2;if(r.status!==exitCode)throw new Error('Exit/report mismatch');return {...report,exitCode};}catch(e){return {status:'incomplete',exitCode:2,reason:e.message+'; '+r.stderr.slice(-1000)};}
}
