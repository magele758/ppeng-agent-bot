import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = () => import('../formal/lifecycle-verifier.mjs');
let runtime;
const report = async () => runtime ??= (await lib()).verifyRuntime();
async function passing(names) {
  const evidence = await report();
  assert.equal(evidence.completed, true, JSON.stringify(evidence));
  for (const name of names) {
    const row = evidence.scenarios.find(x => x.name === name);
    assert.equal(row?.status, 'pass', JSON.stringify(row));
  }
}
test('normal chat/task status and outcome agree [AC:session-lifecycle-verification#AC-1]', async () => {
  await passing(['chat', 'task']);
});
test('cancellation settles model/tool/retry/approval waits [AC:session-lifecycle-verification#AC-2]', async () => {
  await passing(['cancel-model', 'cancel-tool', 'cancel-retry', 'cancel-approval']);
});
test('late events cannot rewrite an ended run or affect the next run [AC:session-lifecycle-verification#AC-3]', async () => {
  await passing(['late-cancel-completed', 'late-cancel-failed', 'late-cancel-aborted', 'old-signal-new-run', 'old-approval-new-run', 'old-retry-new-run']);
});
test('retry succeeds or fails without stale running state or tool replay [AC:session-lifecycle-verification#AC-4]', async () => {
  await passing(['retry-success', 'retry-exhausted', 'retry-after-tool']);
});
test('one of two decisions leaves the session waiting [AC:session-lifecycle-verification#AC-5]', async () => {
  await passing(['approval-wait', 'approval-partial']);
});
test('approval resume only executes permitted remaining work once [AC:session-lifecycle-verification#AC-6]', async () => {
  await passing(['approval-resume', 'approval-mixed', 'approval-rejected']);
});
test('report separates bounded model from actual public runtime [AC:session-lifecycle-verification#AC-7]', async () => {
  const { exploreLifecycleModel, SCOPE } = await lib();
  const model = exploreLifecycleModel();
  assert.equal(model.status, 'pass');
  assert.equal(model.exhausted, true);
  assert.ok(model.states > 100 && model.transitions > model.states);
  assert.ok(SCOPE.assumptions.length && SCOPE.exclusions.length);
  assert.equal((await report()).engine, 'RawAgentRuntime/SQLite/agent-loop');
});
test('counterexamples retain run identity, observed state and replayable ordering [AC:session-lifecycle-verification#AC-8]', async () => {
  const { exploreLifecycleModel, replayLifecycle } = await lib();
  for (const fault of ['cancel', 'retry', 'approval']) {
    const broken = exploreLifecycleModel({ fault });
    assert.equal(broken.status, 'fail');
    assert.ok(broken.counterexample.events.length);
    assert.deepEqual(replayLifecycle(broken.counterexample.events, { fault }), broken.counterexample.check);
  }
  for (const row of (await report()).scenarios.filter(x => x.status === 'fail')) {
    assert.ok(row.events.length && row.checks.some(x => !x.ok));
    assert.ok(row.snapshots.every(x => x.run && x.status));
  }
});
test('three isolated product mutations fail newly and restore baseline [AC:session-lifecycle-verification#AC-9]', async () => {
  const evidence = await (await lib()).verifyLifecycleMutations();
  assert.equal(evidence.status, 'pass', JSON.stringify(evidence));
  assert.equal(evidence.restored, true);
  assert.deepEqual(evidence.mutants.map(x => x.name), ['cancel', 'retry', 'approval']);
  assert.ok(evidence.mutants.every(x => x.killed && x.counterexample && x.before !== x.after));
});
test('fixed-input runs are reproducible and missing/timed-out/incomplete checks fail closed [AC:session-lifecycle-verification#AC-10]', async () => {
  const { exploreLifecycleModel, runLifecycleProcess } = await lib();
  assert.deepEqual(exploreLifecycleModel(), exploreLifecycleModel());
  assert.equal(exploreLifecycleModel({ maxStates: 1 }).status, 'incomplete');
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  try {
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, 'setInterval(() => {}, 1000)');
    assert.equal(runLifecycleProcess({ worker, timeoutMs: 50 }).status, 'incomplete');
    assert.equal(runLifecycleProcess({ executable: join(dir, 'missing') }).status, 'incomplete');
    writeFileSync(worker, 'console.log(JSON.stringify({schema:1,status:"pass"}))');
    assert.equal(runLifecycleProcess({ worker }).status, 'incomplete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('covered lifecycle sources and checker changes require review [AC:session-lifecycle-verification#AC-11]', async () => {
  const { checkLifecycleReview, ROOT } = await lib();
  assert.equal(checkLifecycleReview().status, 'reviewed');
  for (const suffix of ['session-control.ts', 'lifecycle-model.mjs']) {
    const changed = checkLifecycleReview({ read: p => readFileSync(p, 'utf8') + (p.endsWith(suffix) ? '\n// changed' : '') });
    assert.equal(changed.status, 'needs-review');
  }
  assert.match(readFileSync(join(ROOT, 'skills/verify-session-lifecycle/SKILL.md'), 'utf8'), /pnpm run test:lifecycle/);
});
