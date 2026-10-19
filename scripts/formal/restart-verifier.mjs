import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { CASES } from './restart-cases.mjs';
import { MUTATIONS } from './restart-mutations.mjs';
export { SCOPE, exploreRestartModel, replayRestart } from './restart-model.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=s=>createHash('sha256').update(s).digest('hex');
const env=()=>sanitizeScriptEnv({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP});
let built=false;
function build(){if(built)return;const ts=JSON.parse(readFileSync(join(ROOT,'node_modules/typescript/package.json')));if(ts.version!=='5.9.3')throw new Error('TypeScript 5.9.3 required; npm ci');const r=spawnSync(process.execPath,[join(ROOT,'node_modules/typescript/bin/tsc'),'-b','packages/core'],{cwd:ROOT,env:env(),encoding:'utf8',timeout:60000,maxBuffer:4e6});if(r.error||r.status!==0)throw new Error('Fresh core build failed: '+(r.error?.message??r.stdout+r.stderr));built=true;}
export async function verifyRestartRuntime({mutation,only,childExecutable,executable=process.execPath}={}){
  build();const r=spawnSync(executable,[join(ROOT,'scripts/formal/restart-runtime.mjs'),'--config',JSON.stringify({mutation,only,childExecutable})],{cwd:ROOT,env:env(),encoding:'utf8',timeout:180000,maxBuffer:20e6});
  if(r.error||r.signal)return {completed:false,status:'incomplete',reason:r.error?.message??r.signal,scenarios:[]};
  try{const report=JSON.parse(r.stdout);if(!report.scenarios?.length||![0,1,2].includes(r.status))throw new Error('Missing runtime stages');if(report.completed){const expected=CASES.filter(c=>!only||only.includes(c.name)).map(c=>c.name);if(JSON.stringify(report.scenarios.map(s=>s.name))!==JSON.stringify(expected)||report.scenarios.some(s=>!['pass','fail'].includes(s.status)||!s.checks.length||!s.snapshots.length||s.processes.length<2||s.processes.some(p=>!p.freshPid||!p.exitedBeforeNext)))throw new Error('Missing process/scenario completion evidence');const status=report.scenarios.every(s=>s.status==='pass')?'pass':'fail';if(report.status!==status||r.status!==(status==='pass'?0:1))throw new Error('Runtime exit/status mismatch');}else if(report.status!=='incomplete'||r.status!==2)throw new Error('Incomplete runtime misreported');return report;}catch(e){return {completed:false,status:'incomplete',reason:e.message+'; '+r.stderr.slice(-1200),scenarios:[]};}
}
export async function verifyRestartMutations(){
  const only=Object.values(MUTATIONS).flatMap(m=>m.cases),baseline=await verifyRestartRuntime({only}),mutants=[];
  if(!baseline.completed)throw new Error('Mutation baseline incomplete: '+JSON.stringify(baseline));
  for(const [name,m]of Object.entries(MUTATIONS)){
    const source=readFileSync(join(ROOT,m.file),'utf8');if(source.split(m.from).length!==2)throw new Error('Mutation anchor drift: '+name);
    const after=await verifyRestartRuntime({only:m.cases,mutation:name});
    const counterexample=after.scenarios.find(s=>s.status==='fail'&&baseline.scenarios.find(b=>b.name===s.name)?.status==='pass');
    const loaded=after.scenarios.some(s=>s.mutationLoaded);
    mutants.push({name,file:m.file,before:sha(source),after:sha(source.replace(m.from,m.to)),loaded,killed:loaded&&!!counterexample,counterexample});
  }
  const restored=JSON.stringify(baseline)===JSON.stringify(await verifyRestartRuntime({only}));
  return {status:restored&&mutants.every(m=>m.killed)?'pass':'fail',baselineStatus:baseline.status,baseline,restored,mutants};
}
export function checkRestartReview({read=p=>readFileSync(p,'utf8')}={}){
  const m=JSON.parse(readFileSync(join(ROOT,'specs/formal/restart-review.json')));
  const changed=[...new Set([...m.mapping.flatMap(r=>r.files),...Object.keys(m.sha256)])].filter(p=>{try{return sha(read(join(ROOT,p)))!==m.sha256[p];}catch{return true;}});
  return {status:changed.length?'needs-review':'reviewed',changed,mapping:m.mapping};
}
export function restartVerdict(r){
  if(r.model?.status==='incomplete'||!r.runtime?.completed||r.existing?.lifecycle?.status==='incomplete'||r.existing?.pairing?.status==='incomplete')return 'incomplete';
  return r.model?.status==='pass'&&r.model.exhausted&&r.runtime.status==='pass'&&r.mutations?.status==='pass'&&r.mutations.restored&&r.review?.status==='reviewed'&&r.existing?.lifecycle?.status==='pass'&&r.existing?.pairing?.status==='pass'?'pass':'fail';
}
export function runRestartProcess({executable=process.execPath,worker=join(ROOT,'scripts/formal/restart-worker.mjs'),timeoutMs=300000}={}){
  const r=spawnSync(executable,[worker],{cwd:ROOT,env:env(),encoding:'utf8',timeout:timeoutMs,killSignal:'SIGKILL',detached:process.platform!=='win32',maxBuffer:30e6});
  if(r.error||r.signal){
    // The worker owns a process group; a timeout must also stop its runtime grandchildren.
    if(r.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(r.pid),'/T','/F'],{env:env(),timeout:5000,stdio:'ignore'});else try{process.kill(-r.pid,'SIGKILL');}catch{}}
    return {status:'incomplete',exitCode:2,reason:r.error?.message??r.signal};
  }
  try{const report=JSON.parse(r.stdout);if(report.schema!==1||!['pass','fail','incomplete'].includes(report.status))throw new Error('Invalid report');if(report.status!=='incomplete'&&(!report.model||!report.runtime||!report.mutations||!report.existing||!report.review||report.negativeControls?.length!==3))throw new Error('Missing verification stages');if(report.status==='pass'&&(restartVerdict(report)!=='pass'||report.negativeControls.some(n=>n.result.status!=='fail')))throw new Error('False success report');const exitCode=report.status==='pass'?0:report.status==='fail'?1:2;if(r.status!==exitCode)throw new Error('Exit/report mismatch');return {...report,exitCode};}catch(e){return {status:'incomplete',exitCode:2,reason:e.message+'; '+r.stderr.slice(-1000)};}
}
