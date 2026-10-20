// Run one independent lane. A success bundle is sealed only after every required
// command succeeded and source/compiled inputs stayed unchanged.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
import {ROOT,discoverTests} from './test-partition.mjs';
import {currentIdentity,writeBundle} from './validation-artifacts.mjs';
const [lane,option,out]=process.argv.slice(2);
if(!['unit','formal','sdk'].includes(lane)||option!=='--out'||!out)throw new Error('Usage: validation-lane.mjs unit|formal|sdk --out <fresh-directory>');
const directory=resolve(out),start=performance.now(),identity=currentIdentity(),plan=discoverTests();
mkdirSync(directory,{recursive:false});mkdirSync(join(directory,'results'));
const env=sanitizeScriptEnv();
if(lane!=='sdk'){
  env.NODE_V8_COVERAGE=join(directory,'node');
  mkdirSync(join(directory,'node'));mkdirSync(join(directory,'flaky'));
  if(lane==='formal'){
    if(!env.CI_VERIFICATION_EVIDENCE_DIR||!env.CI_VERIFICATION_RUN_ID)throw new Error('Formal requires strict per-run evidence identity');
  }
}
const timings=[];
function run(args,cwd=ROOT){const at=performance.now();const r=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit'});timings.push({command:args,durationSeconds:(performance.now()-at)/1000,exitCode:r.status,signal:r.signal,error:r.error?.message});if(r.error||r.status!==0)throw new Error(`Lane ${lane} failed (${r.error?.message??r.signal??r.status}): ${args[0]}`);}
try{
  if(lane==='sdk'){
    const require=createRequire(join(ROOT,'packages/agent-loop/package.json'));
    const cli=join(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
    run([cli,'run','--coverage.enabled','--coverage.provider=v8','--coverage.reporter=json',`--coverage.reportsDirectory=${join(directory,'vitest')}`,'--reporter=default','--reporter=junit',`--outputFile.junit=${join(directory,'results/sdk.xml')}`],join(ROOT,'packages/agent-loop'));
  }else{
    run(['scripts/ci/retry-failed-tests.mjs','--script','test:unit','--lane',lane,'--label',`${lane}-coverage`,'--report',join(directory,`flaky/${lane}.json`),'--junit',join(directory,`results/${lane}.xml`),...(lane==='formal'?['--max-retry-files','0']:[])]);
    // Same executable, PATH, artifacts and evidence directory as the test consumers.
    // The four regression test files already ran in this lane; do not repeat them.
    if(lane==='formal')run(['scripts/formal/run-formal-regression.mjs','--verification-only']);
  }
  if(JSON.stringify(identity)!==JSON.stringify(currentIdentity()))throw new Error('Validation inputs changed while executing lane');
  writeFileSync(join(directory,'timing.json'),JSON.stringify({lane,identity,timings,durationSeconds:(performance.now()-start)/1000},null,2)+'\n');
  writeBundle({directory,lane,identity,inventory:plan[lane],elapsedSeconds:(performance.now()-start)/1000});
} catch(error){
  writeFileSync(join(directory,'failure.json'),JSON.stringify({lane,identity,timings,durationSeconds:(performance.now()-start)/1000,error:error.message},null,2)+'\n');
  console.error(error.stack);process.exitCode=1;
}
