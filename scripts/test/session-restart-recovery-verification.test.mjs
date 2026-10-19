import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const lib = () => import('../formal/restart-verifier.mjs');
let runtime;
const report = async () => runtime ??= (await lib()).verifyRestartRuntime();
async function criterion(id) {
  const r = await report();
  assert.equal(r.completed, true, JSON.stringify(r));
  const checks = r.scenarios.flatMap(s => s.checks.filter(c => c.criterion === id).map(c => ({ scenario: s.name, ...c })));
  assert.ok(checks.length, `No actual checks for ${id}`);
  assert.deepEqual(checks.filter(c => !c.ok), []);
}
test('restart settles lost model/tool execution truthfully [AC:session-restart-recovery-verification#AC-1]', () => criterion('AC-1'));
test('restart does not resurrect old model retry [AC:session-restart-recovery-verification#AC-2]', () => criterion('AC-2'));
test('pending approvals survive real restart [AC:session-restart-recovery-verification#AC-3]', () => criterion('AC-3'));
test('partial decisions persist and remain waiting [AC:session-restart-recovery-verification#AC-4]', () => criterion('AC-4'));
test('approved restart resume executes only unfinished allowed operations once [AC:session-restart-recovery-verification#AC-5]', () => criterion('AC-5'));
test('cancel after restart fences old decisions across another restart [AC:session-restart-recovery-verification#AC-6]', () => criterion('AC-6'));
test('fresh run after restart is separate from old work [AC:session-restart-recovery-verification#AC-7]', () => criterion('AC-7'));
test('terminal data and recovery are stable over repeated restarts [AC:session-restart-recovery-verification#AC-8]', () => criterion('AC-8'));
test('persisted and unconfirmed tool work stay paired without replay [AC:session-restart-recovery-verification#AC-9]', () => criterion('AC-9'));
test('report separates model from distinct exited and restarted processes [AC:session-restart-recovery-verification#AC-10]', async () => {
  const { exploreRestartModel, replayRestart, SCOPE } = await lib();
  const m = exploreRestartModel();
  assert.equal(m.status, 'pass'); assert.equal(m.exhausted, true);
  assert.ok(m.states > 100 && m.transitions > m.states);
  assert.ok(SCOPE.assumptions.length && SCOPE.exclusions.length);
  for(const fault of ['running','retry','approval']){const broken=exploreRestartModel({fault});assert.equal(broken.status,'fail');assert.deepEqual(replayRestart(broken.counterexample.events,{fault}),broken.counterexample.check);}
  const r = await report();
  assert.equal(r.completed,true,JSON.stringify(r));
  assert.ok(r.scenarios.some(s => s.termination === 'SIGKILL'));
  assert.ok(r.scenarios.some(s => s.termination === 'SIGTERM'));
  assert.ok(r.scenarios.every(s => s.processes.every(p => p.exitedBeforeNext && p.freshPid) && s.events.length && s.snapshots.length));
});
test('isolated real startup/retry/approval mutations add new failures then restore [AC:session-restart-recovery-verification#AC-11]', async () => {
  const r = await (await lib()).verifyRestartMutations();
  assert.equal(r.status, 'pass', JSON.stringify(r)); assert.equal(r.restored, true);
  assert.deepEqual(r.mutants.map(m => m.name), ['running', 'retry', 'approval']);
  assert.ok(r.mutants.every(m => m.loaded && m.killed && m.counterexample && m.before !== m.after));
});
test('repeatable verification fails closed for missing/timeout/incomplete processes [AC:session-restart-recovery-verification#AC-12]', async () => {
  const { exploreRestartModel, runRestartProcess, verifyRestartRuntime } = await lib();
  assert.deepEqual(exploreRestartModel(), exploreRestartModel());
  assert.equal(exploreRestartModel({ maxStates: 1 }).status, 'incomplete');
  const subset = ['terminal-completed-chat-SIGKILL', 'approval-pending-task-SIGTERM'];
  assert.deepEqual(await verifyRestartRuntime({ only: subset }), await verifyRestartRuntime({ only: subset }));
  const dir = mkdtempSync(join(tmpdir(), 'restart-check-'));
  try {
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, 'setInterval(() => {}, 1000)');
    assert.equal(runRestartProcess({ worker, timeoutMs: 50 }).status, 'incomplete');
    assert.equal(runRestartProcess({ executable: join(dir, 'missing') }).status, 'incomplete');
    writeFileSync(worker, 'console.log(JSON.stringify({schema:1,status:"pass"}))');
    assert.equal(runRestartProcess({ worker }).status, 'incomplete');
    assert.equal((await verifyRestartRuntime({ executable: join(dir, 'missing'), only: subset })).completed, false);
    assert.equal((await verifyRestartRuntime({ childExecutable: join(dir, 'missing'), only: [subset[0]] })).completed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('source drift and failed existing verifiers block the combined gate [AC:session-restart-recovery-verification#AC-13]', async () => {
  const { checkRestartReview, restartVerdict, ROOT } = await lib();
  assert.equal(checkRestartReview().status, 'reviewed');
  for (const suffix of ['runtime.ts', 'restart-model.mjs']) assert.equal(checkRestartReview({ read: p => readFileSync(p, 'utf8') + (p.endsWith(suffix) ? '\n// changed' : '') }).status, 'needs-review');
  const pass = { model: { status: 'pass', exhausted: true }, runtime: { status: 'pass', completed: true }, mutations: { status: 'pass', restored: true }, review: { status: 'reviewed' }, existing: { lifecycle: { status: 'pass' }, pairing: { status: 'pass' } } };
  for (const key of ['lifecycle', 'pairing']) assert.equal(restartVerdict({ ...pass, existing: { ...pass.existing, [key]: { status: 'fail' } } }), 'fail');
  assert.match(readFileSync(join(ROOT, 'skills/verify-session-restart/SKILL.md'), 'utf8'), /npm run test:restart/);
});
