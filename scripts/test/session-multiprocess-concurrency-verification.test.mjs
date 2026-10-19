import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const lib = () => import('../formal/concurrency-verifier.mjs');
let current;
const report = async () => current ??= (await lib()).verifyConcurrencyRuntime();
async function criterion(id) {
  const r = await report();
  assert.equal(r.completed, true, JSON.stringify(r));
  const checks = r.scenarios.flatMap(s => s.checks.filter(c => c.criterion === id).map(c => ({ scenario: s.name, ...c })));
  assert.ok(checks.length, `Missing real checks for ${id}`);
  assert.deepEqual(checks.filter(c => !c.ok), []);
}
test('one initial writer wins across live processes [AC:session-multiprocess-concurrency-verification#AC-1]', () => criterion('AC-1'));
test('live model/tool/retry owner survives competing boot and run [AC:session-multiprocess-concurrency-verification#AC-2]', () => criterion('AC-2'));
test('stale release/cancel/finally cannot alter the current owner [AC:session-multiprocess-concurrency-verification#AC-3]', () => criterion('AC-3'));
test('legal handoff admits exactly one successor [AC:session-multiprocess-concurrency-verification#AC-4]', () => criterion('AC-4'));
test('late model/tool returns cannot affect a new run [AC:session-multiprocess-concurrency-verification#AC-5]', () => criterion('AC-5'));
test('concurrent matching/opposed approval decisions are consistent [AC:session-multiprocess-concurrency-verification#AC-6]', () => criterion('AC-6'));
test('partial approval remains waiting across processes [AC:session-multiprocess-concurrency-verification#AC-7]', () => criterion('AC-7'));
test('concurrent final approval resume executes allowed work once [AC:session-multiprocess-concurrency-verification#AC-8]', () => criterion('AC-8'));
test('cancel versus approval resume has a coherent order [AC:session-multiprocess-concurrency-verification#AC-9]', () => criterion('AC-9'));
test('concurrent histories preserve results/order/model pairing [AC:session-multiprocess-concurrency-verification#AC-10]', () => criterion('AC-10'));
test('unrelated session progresses independently [AC:session-multiprocess-concurrency-verification#AC-11]', () => criterion('AC-11'));
test('model replay and real overlapping process evidence are separate [AC:session-multiprocess-concurrency-verification#AC-12]', async () => {
  const { exploreConcurrencyModel, replayConcurrency, SCOPE } = await lib();
  const m = exploreConcurrencyModel();
  assert.equal(m.status,'pass'); assert.equal(m.exhausted,true); assert.ok(m.states > 100 && m.transitions > m.states);
  assert.ok(SCOPE.assumptions.length && SCOPE.exclusions.length);
  for (const fault of ['ownership','stale','approval']) {
    const broken=exploreConcurrencyModel({fault}); assert.equal(broken.status,'fail');
    assert.deepEqual(replayConcurrency(broken.counterexample.events,{fault}),broken.counterexample.check);
  }
  const r=await report(); assert.equal(r.completed,true,JSON.stringify(r));
  assert.ok(r.scenarios.length >= 20);
  assert.ok(r.scenarios.every(s=>s.overlapConfirmed && s.processes.length>=2 && s.events.length && s.snapshots.length && s.checks.length));
});
test('three real source faults add new failures and restore [AC:session-multiprocess-concurrency-verification#AC-13]', async () => {
  const r=await (await lib()).verifyConcurrencyMutations();
  assert.equal(r.status,'pass',JSON.stringify(r)); assert.equal(r.restored,true);
  assert.deepEqual(r.mutants.map(m=>m.name),['ownership','stale','approval']);
  assert.ok(r.mutants.every(m=>m.loaded && m.killed && m.counterexample && m.before!==m.after && m.sourceUnchanged));
});
test('fixed schedules repeat and incomplete probes fail closed [AC:session-multiprocess-concurrency-verification#AC-14]', async () => {
  const { exploreConcurrencyModel, verifyConcurrencyRuntime, runConcurrencyProcess }=await lib();
  assert.deepEqual(exploreConcurrencyModel(),exploreConcurrencyModel());
  assert.equal(exploreConcurrencyModel({maxStates:1}).status,'incomplete');
  const only=['boot-live-model-chat','approval-partial-chat'];
  assert.deepEqual(await verifyConcurrencyRuntime({only}),await verifyConcurrencyRuntime({only}));
  assert.equal((await verifyConcurrencyRuntime({only,childExecutable:'/missing/concurrency-node'})).completed,false);
  assert.equal((await verifyConcurrencyRuntime({only,failBarrier:true})).completed,false);
  const dir=mkdtempSync(join(tmpdir(),'concurrency-check-'));
  try {
    const worker=join(dir,'worker.mjs');writeFileSync(worker,'setInterval(()=>{},1000)');
    assert.equal(runConcurrencyProcess({worker,timeoutMs:50}).status,'incomplete');
    const marker=join(dir,'grandchild.pid');
    writeFileSync(worker,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';import{sanitizeScriptEnv}from${JSON.stringify(pathToFileURL(join((await lib()).ROOT,'scripts/spawn-utils.mjs')).href)};const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:sanitizeScriptEnv(),stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},String(p.pid));setInterval(()=>{},1000);`);
    assert.equal(runConcurrencyProcess({worker,timeoutMs:500}).status,'incomplete');
    const grandchild=Number(readFileSync(marker,'utf8'));let alive=true;
    const deadline=Date.now()+1500;while(alive&&Date.now()<deadline){try{process.kill(grandchild,0);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}catch{alive=false;}}
    assert.equal(alive,false,'outer timeout must reap runtime grandchildren');
    assert.equal(runConcurrencyProcess({executable:join(dir,'missing')}).status,'incomplete');
    writeFileSync(worker,'console.log(JSON.stringify({schema:1,status:"pass"}))');
    assert.equal(runConcurrencyProcess({worker}).status,'incomplete');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('source drift and prior verifier failures block verdict [AC:session-multiprocess-concurrency-verification#AC-15]', async () => {
  const { checkConcurrencyReview, concurrencyVerdict, ROOT }=await lib();
  assert.equal(checkConcurrencyReview().status,'reviewed');
  for(const suffix of ['session-store.ts','concurrency-model.mjs'])assert.equal(checkConcurrencyReview({read:p=>readFileSync(p,'utf8')+(p.endsWith(suffix)?'\n// drift':'')}).status,'needs-review');
  const good={model:{status:'pass',exhausted:true},runtime:{completed:true,status:'pass'},review:{status:'reviewed'},mutations:{status:'pass',restored:true},existing:{restart:{status:'pass'},lifecycle:{status:'pass'},pairing:{status:'pass'}}};
  assert.equal(concurrencyVerdict(good),'pass');
  for(const key of ['restart','lifecycle','pairing'])assert.equal(concurrencyVerdict({...good,existing:{...good.existing,[key]:{status:'fail'}}}),'fail');
  assert.match(readFileSync(join(ROOT,'skills/verify-session-concurrency/SKILL.md'),'utf8'),/npm run test:concurrency/);
});
