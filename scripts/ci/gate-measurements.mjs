/** Read-only real-run comparison. Downloads immutable GitHub evidence, never launches tests. */
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
import {compareGateRuns} from './verification-evidence.mjs';

export function validateAttemptIds(before,after) {
  const ids=[...before,...after];
  if(ids.some(id=>!/^\d+$/.test(id))||new Set(ids).size!==ids.length)throw new Error('Every supplied attempt ID must be distinct across both schedules');
}

export function measureRun({run,jobs,provenance,cleanUnit=true}) {
  if(run.status!=='completed'||run.run_attempt!==1)throw new Error('Only completed first-attempt runs may be measured');
  if(provenance.schema!==1||String(provenance.runId)!==String(run.id)||String(provenance.attempt)!=='1'||!provenance.node||!provenance.candidate||!provenance.environment)throw new Error('Missing or mismatched measured candidate provenance');
  const measured=jobs.filter(j=>j.conclusion!=='skipped');
  const times=measured.map(j=>[Date.parse(j.started_at),Date.parse(j.completed_at)]);
  if(!times.length||times.some(([s,e])=>!Number.isFinite(s)||!Number.isFinite(e)||e<s))throw new Error('Incomplete or unsuccessful jobs cannot support a timing claim');
  const start=Math.min(...times.map(t=>t[0])),end=Math.max(...times.map(t=>t[1]));
  const queueSeconds=(start-Date.parse(run.created_at))/1000;
  if(!Number.isFinite(queueSeconds)||queueSeconds<0)throw new Error('Invalid queue timestamps');
  return {id:String(run.id),candidate:provenance.candidate,environment:JSON.stringify([provenance.node,provenance.environment]),scope:provenance.scope,
    complete:run.conclusion==='success'&&measured.every(j=>j.conclusion==='success'),firstPass:run.conclusion==='success'&&cleanUnit&&measured.every(j=>j.conclusion==='success'),queueSeconds,executionSeconds:(end-start)/1000,computeSeconds:times.reduce((n,[s,e])=>n+(e-s)/1000,0)};
}

function files(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]);
}
function gh(args) {
  const r=spawnSync('gh',args,{env:sanitizeScriptEnv(),encoding:'utf8',maxBuffer:64e6,timeout:120000});
  if(r.status!==0||r.error)throw new Error(`GitHub evidence read failed: ${r.stderr||r.error}`);
  return r.stdout;
}
function collect(repo,id,schedule,out) {
  const directory=join(out,String(id));mkdirSync(directory,{recursive:true});
  const endpoint=`repos/${repo}/actions/runs/${id}`;
  const run=JSON.parse(gh(['api',endpoint]));
  if(run.status!=='completed'||run.run_attempt!==1)throw new Error(`${id}: completed first-attempt runs only; retain reruns separately, never count them as samples`);
  const pages=JSON.parse(gh(['api',`${endpoint}/jobs?per_page=100`,'--paginate','--slurp']));
  const jobs=pages.flatMap(page=>page.jobs);
  writeFileSync(join(directory,'api.json'),JSON.stringify({run,jobs},null,2)+'\n');
  // Keep every preselected failed attempt in the first-pass denominator.
  // Timing comparison is stricter: only full green executions qualify.
  if(run.status==='completed'&&run.conclusion!=='success') {
    const row={id:String(id),complete:false,firstPass:false,conclusion:run.conclusion};
    writeFileSync(join(directory,'measurement.json'),JSON.stringify(row,null,2)+'\n');return row;
  }
  let cleanUnit=true;
  const prefix=schedule==='before'?'Benchmark baseline / ':'Release gate / ';
  const stepNames=jobs.filter(j=>j.name.startsWith(prefix)).flatMap(j=>(j.steps??[]).filter(s=>s.conclusion==='success').map(s=>s.name));
  const required=['TypeScript build','Bot queue and process recovery invariants (no retries)','Install and exercise public npm tarballs','Fast capability contracts (fail on any failed case)',
    'Verify evaluator against scripted harness outcomes (not live model quality)','Formal invariants + MockLLM E2E','Unit tests with V8 coverage','agent-loop vitest with coverage','CRAP gate',
    'Regression (daemon + API)','Integration (mailbox + approval + social)','E2E (Agent Lab)','Acceptance gate (every approved criterion has a passing test)',
    'Merge shard reports and check the baseline','Require blocking checks and report diagnostic Harness outcome'];
  required.push(...(schedule==='before'?['Unit tests','Bounded pairing verification (no retries)','Session lifecycle verification (no retries)','Process restart recovery verification (no retries)','Multiprocess session verification (no retries)']:['Preserve stricter uninstrumented performance contracts']));
  for(const name of required)if(!stepNames.includes(name))throw new Error(`${id}: missing successful mandatory step ${name}`);
  for(const shard of ['hardline-1','hardline-2','hardline-3','others'])if(!jobs.some(j=>j.name.startsWith(prefix)&&j.name.endsWith(`Mutate (${shard})`)&&j.conclusion==='success'))throw new Error(`${id}: missing mutation shard ${shard}`);
  const artifacts=['gate-provenance','flaky-tests-unit-coverage','acceptance-results-unit','acceptance-results-e2e','mutation-report','crap-report','acceptance-report',
    'tool-call-pairing-verification','session-lifecycle-verification','session-restart-recovery-verification','session-multiprocess-concurrency-verification'];
  if(schedule==='before')artifacts.push('flaky-tests-unit');
  for(const name of artifacts) {
    const target=join(directory,name);mkdirSync(target,{recursive:true});
    gh(['run','download',String(id),'--repo',repo,'--name',name,'--dir',target]);
    if(!files(target).length)throw new Error(`${id}: empty ${name}`);
  }
  for(const name of artifacts.filter(n=>n.startsWith('flaky-tests-'))) {
    const reports=files(join(directory,name)).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(f,'utf8')));
    if(!reports.length||reports.some(r=>!r.pass||r.failed?.length))throw new Error(`${id}: missing or failed unit result`);
    if(reports.some(r=>r.firstExitCode!==0||r.retried||r.flaky?.length))cleanUnit=false;
  }
  for(const name of ['acceptance-results-unit','acceptance-results-e2e']) {
    const xml=files(join(directory,name)).filter(f=>f.endsWith('.xml'));
    if(!xml.length||xml.some(f=>/\b(?:failures|errors)="[1-9]|<failure\b|<error\b/.test(readFileSync(f,'utf8'))))throw new Error(`${id}: missing or failed actual JUnit evidence`);
  }
  const provenance=JSON.parse(readFileSync(join(directory,'gate-provenance','gate-provenance.json'),'utf8'));
  const row=measureRun({run,jobs,provenance,cleanUnit});
  writeFileSync(join(directory,'measurement.json'),JSON.stringify(row,null,2)+'\n');return row;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [repo,beforeIds,afterIds,destination]=process.argv.slice(2);
  if(!repo||!beforeIds||!afterIds||!destination)throw new Error('Usage: gate-measurements.mjs owner/repo before-id,... after-id,... output-dir');
  const out=resolve(destination);mkdirSync(out,{recursive:true});
  validateAttemptIds(beforeIds.split(','),afterIds.split(','));
  const before=beforeIds.split(',').map(id=>collect(repo,id,'before',out));
  const after=afterIds.split(',').map(id=>collect(repo,id,'after',out));
  const comparison=compareGateRuns(before.filter(r=>r.complete),after.filter(r=>r.complete));
  comparison.attempts={before:before.length,after:after.length};
  comparison.firstPassRate={before:before.filter(r=>r.firstPass).length/before.length,after:after.filter(r=>r.firstPass).length/after.length};
  comparison.sampling='Timing requires at least three complete all-green runs per schedule; first-pass denominator includes every supplied attempt, including failures and nonblocking diagnostic failures. No attempts may be silently omitted.';
  writeFileSync(join(out,'comparison.json'),JSON.stringify({before,after,comparison},null,2)+'\n');
  console.log(JSON.stringify(comparison,null,2));if(!comparison.pass)process.exitCode=1;
}
