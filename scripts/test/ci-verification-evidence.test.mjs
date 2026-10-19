import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const implementation = await import('../ci/verification-evidence.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
function fixture(t) {
  assert.equal(typeof implementation.withVerificationEvidence, 'function', 'same-candidate evidence reuse is not implemented');
  const root = mkdtempSync(join(tmpdir(), 'ci-evidence-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'input.txt'), 'approved input');
  for (const args of [['init', '-q'], ['add', 'input.txt']]) {
    const result = spawnSync('git', args, { cwd: root, env: sanitizeScriptEnv(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, directory: join(root, '.git', 'evidence'), kind: 'runtime', runId: 'candidate-attempt', environment: { PATH: '/controlled/tools' } };
}
const pass = () => ({ status: 'pass', completed: true, scenarios: [{ name: 'real-probe', status: 'pass' }] });

test('one complete same-input probe serves multiple consumers, preserving its actual evidence [AC:ci-gate-speedup#AC-2]', async t => {
  const context = fixture(t); let calls = 0;
  const execute = async () => { calls++; return pass(); };
  const first = await implementation.withVerificationEvidence(context, execute);
  const second = await implementation.withVerificationEvidence(context, execute);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(second.scenarios[0].name, 'real-probe');
});

test('source, options and execution environment changes require fresh probes [AC:ci-gate-speedup#AC-3]', async t => {
  const context = fixture(t); let calls = 0;
  const execute = async () => { calls++; return pass(); };
  await implementation.withVerificationEvidence(context, execute);
  writeFileSync(join(context.root, 'input.txt'), 'changed input');
  await implementation.withVerificationEvidence(context, execute);
  await implementation.withVerificationEvidence({ ...context, environment: { PATH: '/different/tools' } }, execute);
  await implementation.withVerificationEvidence({ ...context, options: { only: ['repeatability-control'] } }, execute);
  await implementation.withVerificationEvidence({ ...context, options: { only: ['repeatability-control'] } }, execute);
  assert.equal(calls, 5, 'explicit repeatability/negative-control invocations must never be memoized');
});

test('corrupted evidence cannot be silently treated as success [AC:ci-gate-speedup#AC-3]', async t => {
  const context = fixture(t);
  await implementation.withVerificationEvidence(context, pass);
  const file = readdirSync(context.directory).find(name => name.endsWith('.json'));
  assert.ok(file);
  const path = join(context.directory, file);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.report.scenarios[0].status = 'fail';
  writeFileSync(path, JSON.stringify(record));
  let calls = 0;
  await assert.rejects(implementation.withVerificationEvidence(context, () => { calls++; return pass(); }), /evidence|integrity/i);
  assert.equal(calls, 0);
});

test('changes to executed ignored build outputs and installed dependencies invalidate evidence [AC:ci-gate-speedup#AC-3]', async t => {
  const context = fixture(t); let calls = 0;
  writeFileSync(join(context.root, '.gitignore'), 'dist/\nnode_modules/\n');
  const build=join(context.root,'packages','core','dist');
  const dependency=join(context.root,'node_modules','dependency');
  mkdirSync(build,{recursive:true});mkdirSync(dependency,{recursive:true});
  writeFileSync(join(build,'runtime.js'),'good');writeFileSync(join(dependency,'index.js'),'good');
  const execute=()=>{calls++;return readFileSync(join(build,'runtime.js'),'utf8')==='good'&&readFileSync(join(dependency,'index.js'),'utf8')==='good'?pass():{status:'fail'};};
  await implementation.withVerificationEvidence(context, execute);
  writeFileSync(join(build,'runtime.js'),'broken');
  assert.equal((await implementation.withVerificationEvidence(context, execute)).status,'fail');
  writeFileSync(join(build,'runtime.js'),'good');writeFileSync(join(dependency,'index.js'),'broken');
  assert.equal((await implementation.withVerificationEvidence(context, execute)).status,'fail');
  assert.equal(calls,3);
});

test('failed and incomplete production probes retain failure and are not reusable [AC:ci-gate-speedup#AC-6]', async t => {
  const context = fixture(t); let calls = 0;
  for (const report of [{ status: 'fail', completed: true }, { status: 'incomplete', completed: false }]) {
    const execute = () => { calls++; return report; };
    assert.deepEqual(await implementation.withVerificationEvidence(context, execute), report);
    assert.deepEqual(await implementation.withVerificationEvidence(context, execute), report);
  }
  assert.equal(calls, 4);
});

test('independent candidates do not reuse another candidates evidence [AC:ci-gate-speedup#AC-4]', async t => {
  const first = fixture(t), second = fixture(t); let calls = 0;
  await Promise.all([first, second].map(context => implementation.withVerificationEvidence(context, async () => { calls++; return pass(); })));
  assert.equal(calls, 2);
  assert.notEqual(first.directory, second.directory);
});

test('overlapping consumers in distinct processes execute a canonical probe only once [AC:ci-gate-speedup#AC-2]', async t => {
  const context=fixture(t), counter=join(context.root,'.git','calls');
  const worker=join(context.root,'.git','consumer.mjs');
  const module=fileURLToPath(new URL('../ci/verification-evidence.mjs',import.meta.url));
  writeFileSync(worker,`import{withVerificationEvidence}from ${JSON.stringify(module)};import{appendFileSync}from'node:fs';await withVerificationEvidence(${JSON.stringify(context)},async()=>{appendFileSync(${JSON.stringify(counter)},'called\\n');await new Promise(r=>setTimeout(r,400));return {status:'pass',completed:true,scenarios:[{name:'probe',status:'pass'}]};});`);
  const children=Array.from({length:2},()=>spawn(process.execPath,[worker],{env:sanitizeScriptEnv(),stdio:['ignore','pipe','pipe']}));
  t.after(()=>children.forEach(child=>child.kill()));
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    let stderr='';child.stderr.on('data',data=>stderr+=data);
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(stderr||`consumer exit ${code}`)));
  })));
  assert.equal(readFileSync(counter,'utf8').trim().split('\n').length,1);
});

test('performance claims require three comparable complete samples and a 30 percent median improvement [AC:ci-gate-speedup#AC-9]', () => {
  assert.equal(typeof implementation.compareGateRuns, 'function', 'auditable speedup evidence is not implemented');
  const sample = (seconds, i) => ({ id: `run-${i}`, candidate: 'same-tree', environment: 'same-runner', scope: ['unit', 'formal', 'mutation', 'e2e'], complete: true, firstPass: true, queueSeconds: 2, executionSeconds: seconds, computeSeconds: seconds * 2 });
  const before = [100, 110, 120].map(sample), after = [60, 65, 70].map((s, i) => sample(s, i + 3));
  assert.equal(implementation.compareGateRuns(before, after).pass, true);
  assert.equal(implementation.compareGateRuns(before.slice(0, 2), after).pass, false);
  assert.equal(implementation.compareGateRuns(before, after.map(r => ({ ...r, scope: ['unit'] }))).pass, false);
  assert.equal(implementation.compareGateRuns(before, [90, 95, 100].map((s, i) => sample(s, i + 3))).pass, false);
  assert.equal(implementation.compareGateRuns(before, after.map(r => ({ ...r, complete: false }))).pass, false);
});
