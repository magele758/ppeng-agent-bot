import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
const started=performance.now(),budgetMs=90000,steps=[];
const revision=spawnSync('git',['rev-parse','HEAD'],{env:sanitizeScriptEnv(),encoding:'utf8'});
let failed;
function run(args){
  const remaining=Math.floor(budgetMs-(performance.now()-started));
  if(remaining<=0)throw new Error('Quick verification execution budget exhausted');
  console.log(`[quick-gate] node ${args.join(' ')}`);
  const at=performance.now(),result=spawnSync(process.execPath,args,{env:sanitizeScriptEnv(),stdio:'inherit',timeout:remaining});
  steps.push({command:args,durationSeconds:(performance.now()-at)/1000,exitCode:result.status,error:result.error?.message});
  if(result.error||result.status!==0)throw new Error(`Quick check failed: ${args[0]} (${result.error?.message??result.status})`);
}
try{
  if(revision.status!==0)throw new Error('Cannot bind quick results to current candidate');
  run(['scripts/ci/changed-complexity.mjs']);
  run(['scripts/ci/reviewed-verification-inputs.mjs']);
  run(['scripts/build-workspace.mjs']);
  run(['node_modules/typescript/bin/tsc','-p','apps/web-console','--noEmit']);
  run(['--experimental-strip-types','--test','packages/core/test/domain-stores.test.js','packages/core/test/session-fork.test.js','packages/core/test/bot-reply-quote.test.js',
    'packages/core/test/bots.test.js','packages/core/test/bot-goal-result-return.test.js','scripts/test/ci-action-reliability.test.mjs','scripts/test/settings-route-contracts.test.mjs','scripts/test/e2e-suite.test.mjs','apps/web-console/lib/feed-window.test.ts',
    'scripts/test/ci-parallel-validation.test.mjs','packages/core/test/approval-policy.test.js','packages/core/test/permission-mode.test.js',
    'scripts/test/ci-fast-bihourly.test.mjs','scripts/test/changed-complexity.test.mjs','scripts/test/main-full-health.test.mjs','scripts/test/core-unit-scope.test.mjs','scripts/test/ci-audit.test.mjs','scripts/test/ci-verification-evidence.test.mjs',
    'scripts/test/ci-evidence-review-drift.test.mjs','scripts/test/ci-performance-clock.test.mjs','scripts/test/ci-gate-measurements.test.mjs',
    'scripts/test/ci-speedup-workflow.test.mjs','scripts/test/release-workflow-policy.test.mjs','scripts/test/acceptance-lib.test.mjs','scripts/test/acceptance-stages.test.mjs']);
  run(['scripts/integration-test.mjs']);
  run(['scripts/acceptance/acceptance-gate.mjs']);
}catch(error){failed=error.message;console.error(failed);process.exitCode=1;}
finally{
  mkdirSync('test-results',{recursive:true});
  writeFileSync('test-results/quick-gate.json',JSON.stringify({schema:1,candidate:revision.stdout?.trim(),status:failed?'fail':'pass',
    failure:failed,durationSeconds:(performance.now()-started)/1000,verification:'quick-only; full verification and deployment evidence remain separately required',steps},null,2)+'\n');
}
