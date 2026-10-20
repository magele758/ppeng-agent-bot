import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifier = () => import('../formal/pairing-verifier.mjs');
let suite;
const sourceSuite = async () => suite ??= (await verifier()).verifySource();

test('normal single and parallel calls retain unique matching results [AC:tool-call-pairing-verification#AC-1]', async () => {
  const report = await sourceSuite();
  for (const name of ['normal', 'parallel-reversed', 'reused-id']) {
    const row = report.scenarios.find(x => x.name === name);
    assert.equal(row?.status, 'complete', JSON.stringify(row));
  }
});

test('failure, unknown, rejection, cancellation, retry and duplicate delivery remain paired [AC:tool-call-pairing-verification#AC-2]', async () => {
  const report = await sourceSuite();
  for (const name of ['failure', 'unknown', 'rejected', 'cancelled', 'retry', 'duplicate-delivery', 'duplicate-batch']) {
    const row = report.scenarios.find(x => x.name === name);
    assert.equal(row?.status, 'complete', JSON.stringify(row));
    if (['failure', 'unknown', 'rejected', 'cancelled'].includes(name)) {
      assert.ok(row.messages.flatMap(m => m.parts).filter(p => p.type === 'tool_result').every(p => p.ok === false && p.content));
    }
  }
});

test('running and approval waits remain pending, not closed or defective [AC:tool-call-pairing-verification#AC-3]', async () => {
  const report = await sourceSuite();
  for (const name of ['running', 'waiting-approval']) {
    assert.equal(report.scenarios.find(x => x.name === name)?.status, 'pending');
  }
});

test('exhaustive exploration reports scope separately from source regression [AC:tool-call-pairing-verification#AC-4]', async () => {
  const { exploreModel, SCOPE } = await verifier();
  const report = exploreModel();
  assert.equal(report.status, 'pass');
  assert.equal(report.exhausted, true);
  assert.ok(report.states > 100);
  assert.ok(report.transitions > report.states);
  assert.equal(report.scope, SCOPE);
  assert.ok(SCOPE.assumptions.length && SCOPE.exclusions.length);
  assert.ok((await sourceSuite()).scenarios.length >= 12);
});

test('broken model produces replayable counterexample; oracle rejects missing, duplicate, orphan and swapped results [AC:tool-call-pairing-verification#AC-5]', async () => {
  const { exploreModel, inspectTranscript, replayModel } = await verifier();
  const report = exploreModel({ fault: 'duplicate' });
  assert.equal(report.status, 'fail');
  assert.ok(report.counterexample.events.length);
  assert.deepEqual(replayModel(report.counterexample.events, { fault: 'duplicate' }), report.counterexample.check);
  const call = id => ({ type: 'tool_call', toolCallId: id, name: 'echo', input: { token: id } });
  const result = (id, token = id) => ({ type: 'tool_result', toolCallId: id, name: 'echo', ok: true, content: `origin:${token}` });
  for (const parts of [[call('a')], [call('a'), result('a'), result('a')], [result('a')], [call('a'), call('b'), result('a', 'b'), result('b', 'a')]]) {
    assert.equal(inspectTranscript([{ parts }], 'ended').status, 'violation');
  }
});

test('isolated real source mutations are killed and restoration reproduces baseline [AC:tool-call-pairing-verification#AC-6]', async () => {
  const report = await (await verifier()).verifyMutations();
  assert.deepEqual(report.mutants.map(x => x.name), ['missing', 'duplicate', 'misassociated']);
  assert.ok(report.mutants.every(x => x.killed && x.counterexample && x.sourceBefore !== x.sourceAfter));
  assert.equal(report.restored, true);
});

test('deterministic runs and incomplete checks fail closed [AC:tool-call-pairing-verification#AC-7]', async () => {
  const { exploreModel, runVerificationProcess } = await verifier();
  assert.deepEqual(exploreModel(), exploreModel());
  assert.equal(exploreModel({ maxStates: 1 }).status, 'incomplete');
  const dir = mkdtempSync(join(tmpdir(), 'pairing-runner-test-'));
  try {
    const slow = join(dir, 'slow.mjs');
    writeFileSync(slow, 'setInterval(() => {}, 1000);');
    for (const options of [{ executable: join(dir, 'missing') }, { worker: slow, timeoutMs: 50 }]) {
      const result = runVerificationProcess(options);
      assert.equal(result.status, 'incomplete');
      assert.notEqual(result.exitCode, 0);
      assert.ok(result.reason);
    }
    const empty = join(dir, 'empty.mjs');
    writeFileSync(empty, '');
    assert.equal(runVerificationProcess({ worker: empty }).status, 'incomplete');
    writeFileSync(empty, 'console.log(JSON.stringify({schema:1,status:"pass"}));');
    assert.equal(runVerificationProcess({ worker: empty }).status, 'incomplete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changed covered source or verification invalidates reviewed fingerprints [AC:tool-call-pairing-verification#AC-8]', async () => {
  const { checkReview, ROOT } = await verifier();
  assert.equal(checkReview().status, 'reviewed');
  const drifted = checkReview({ read: path => readFileSync(path, 'utf8') + (path.endsWith('runtime/tool-loop.ts') ? '\n// changed' : '') });
  assert.equal(drifted.status, 'needs-review');
  assert.ok(drifted.changed.some(x => x.endsWith('runtime/tool-loop.ts')));
  const skill = readFileSync(join(ROOT, 'skills/verify-tool-call-pairing/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: verify-tool-call-pairing/m);
  assert.match(skill, /pnpm run test:pairing/);
});
