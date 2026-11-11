import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { OrchestrationEngine } from '../dist/orchestrator/engine.js';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { validateQualityReport } from '../dist/quality/gate.js';
import { runQualityCheck } from '../dist/runtime/quality-gates.js';

const good = { passed: true, summary: 'verified', checks: [{ criterion: 'correct output', passed: true, evidence: ['read-1'] }] };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-gate-'));
  const db = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { db.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}
test('invalid, failed and missing gate outcomes stop orchestration [AC:collaboration-quality-gates#AC-3]', async t => {
  for (const result of [undefined, 'PASS', { ...good, passed: false }, { passed: true }]) {
    const db = fixture(t), store = db.orchestrator();
    const run = store.createRun({ title: 'quality' });
    store.createStep({ runId: run.id, stage: 'review', executor: 'review', status: 'pending' });
    store.createStep({ runId: run.id, stage: 'test', executor: 'test', status: 'pending' });
    let tests = 0;
    const engine = new OrchestrationEngine({ store, runReview: async () => result, runTest: async () => { tests++; return good; } });
    await engine.tick(); await engine.tick();
    assert.equal(store.getRun(run.id).status, 'failed');
    assert.equal(store.listSteps(run.id)[0].status, 'failed');
    assert.equal(tests, 0);
  }
  const db = fixture(t), store = db.orchestrator(), run = store.createRun({ title: 'exception' });
  store.createStep({ runId: run.id, stage: 'test', executor: 'test', status: 'pending' });
  await new OrchestrationEngine({ store, runTest: async () => { throw Error('test crashed'); } }).tick();
  assert.equal(store.getRun(run.id).status, 'failed');
});
test('all structured checks are needed before orchestration succeeds [AC:collaboration-quality-gates#AC-4]', async t => {
  const db = fixture(t), store = db.orchestrator(), run = store.createRun({ title: 'quality' });
  for (const stage of ['review', 'test']) store.createStep({ runId: run.id, stage, executor: stage, status: 'pending' });
  const engine = new OrchestrationEngine({ store, runReview: async () => good, runTest: async () => good });
  await engine.tick(); await engine.tick(); await engine.tick();
  assert.equal(store.getRun(run.id).status, 'completed');
  assert.deepEqual(JSON.parse(store.listSteps(run.id)[0].outputArtifact), good);
});
test('claims require exact criteria, successful tool evidence and a finished checker [AC:collaboration-quality-gates#AC-5]', () => {
  const messages = [{ role: 'tool', parts: [{ type: 'tool_result', name: 'read_file', toolCallId: 'read-1', ok: true, content: 'actual file' }] }];
  const validate = (report, opts = {}) => validateQualityReport({ report, criteria: ['correct output'], messages, status: 'idle', stage: 'review', ...opts });
  assert.equal(validate(good).passed, true);
  for (const report of [{ ...good, checks: [] }, { ...good, checks: [...good.checks, ...good.checks] }, { ...good, checks: [{ criterion: 'wrong', passed: true, evidence: ['read-1'] }] }, { ...good, checks: [{ ...good.checks[0], evidence: ['invented'] }] }]) assert.equal(validate(report).passed, false);
  const receipt = { ...good, checks: [{ ...good.checks[0], evidence: ['read_file:totals.mjs'] }] };
  const call = { parts: [{ type: 'tool_call', name: 'read_file', toolCallId: 'read-1', input: { path: 'totals.mjs' } }] };
  assert.deepEqual(validate(receipt, { messages: [call, ...messages] }).checks[0].evidence, ['read-1']);
  assert.equal(validate(receipt).passed, false);
  assert.equal(validate(good, { status: 'waiting_approval' }).passed, false);
  assert.equal(validate(good, { stage: 'test' }).passed, false);
  assert.equal(validate(good, { messages: [{ parts: [{ ...messages[0].parts[0], ok: false }] }] }).passed, false);
  const execution = (id, command, code) => ({ parts: [{ type: 'tool_result', toolCallId: id, name: 'work_evidence', ok: code === 0, content: JSON.stringify({ verify: { command, exit_code: code, signal: null } }) }] });
  const passed = { ...good, checks: [{ ...good.checks[0], evidence: ['test-pass'] }] };
  const success = execution('test-pass', 'node --test', 0), failure = execution('test-fail', 'node --test', 1);
  assert.equal(validate(passed, { stage: 'test', messages: [success] }).passed, true);
  assert.equal(validate(passed, { stage: 'test', messages: [success, failure] }).passed, false);
  assert.equal(validate(passed, { stage: 'test', messages: [failure, success] }).passed, true);
  assert.equal(validate(passed, { stage: 'test', messages: [execution('other-fail', 'other-tests', 1), success] }).passed, false);
  assert.equal(validate(passed, { stage: 'test', messages: [success, { parts: [{ type: 'tool_result', name: 'work_evidence', toolCallId: 'aborted', ok: false, content: '{"error":"aborted"}' }] }] }).passed, false);
});

test('checkers inherit workspace and permissions and cannot widen an empty intersection [AC:collaboration-quality-gates#AC-4] [AC:collaboration-quality-gates#AC-5]', async t => {
  const db = fixture(t);
  const parent = db.createSession({ title: 'implementation', agentId: 'general', mode: 'task', metadata: { allowedTools: ['write_file'], permissionMode: 'ask', userId: 'alice', tenantId: 'tenant-a' } });
  let calls = 0;
  const host = { store: db, runSession: async id => { calls++; db.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'read-1', name: 'read_file', ok: true, content: 'artifact' }]); db.appendMessage(id, 'assistant', [{ type: 'text', text: JSON.stringify(good) }]); } };
  const input = { stage: 'review', title: 'correct output', criteria: ['correct output'], implementation: parent, context: 'artifact: totals.mjs' };
  assert.equal((await runQualityCheck(host, input)).passed, false);
  assert.equal(calls, 0);
  db.updateSession(parent.id, { metadata: { ...parent.metadata, allowedTools: ['read_file'] } });
  const report = await runQualityCheck(host, { ...input, implementation: db.getSession(parent.id) });
  assert.equal(report.passed, true);
  const checker = db.getSession(report.sessionId);
  assert.equal(checker.parentSessionId, parent.id);
  assert.equal(checker.metadata.userId, 'alice');
  assert.equal(checker.metadata.tenantId, 'tenant-a');
  assert.deepEqual(checker.metadata.allowedTools, ['read_file']);
  assert.equal(checker.metadata.permissionMode, 'ask');
  assert.match(JSON.stringify(db.foldMessages(checker.id)), /totals.mjs/);
  db.updateSession(parent.id, { metadata: { ...parent.metadata, allowedTools: [] } });
  assert.equal((await runQualityCheck(host, { ...input, implementation: db.getSession(parent.id) })).passed, true);
  db.upsertAgent({ id: 'restricted', name: 'restricted', role: 'implementation', instructions: 'test', capabilities: [], allowedTools: ['write_file'] });
  db.updateSession(parent.id, { agentId: 'restricted' });
  assert.equal((await runQualityCheck(host, { ...input, implementation: db.getSession(parent.id) })).passed, false);
  assert.equal(calls, 2, 'Agent-spec permissions also constrain the checker');
});

test('orchestration exceptions preserve a concurrent external pause [AC:collaboration-quality-gates#AC-3]', async t => {
  const db = fixture(t), store = db.orchestrator(), run = store.createRun({ title: 'paused' });
  store.createStep({ runId: run.id, stage: 'review', executor: 'review', status: 'pending' });
  const engine = new OrchestrationEngine({ store, runReview: async () => { store.updateRunStatus(run.id, 'blocked'); throw Error('interrupted'); } });
  await engine.tick();
  assert.equal(store.getRun(run.id).status, 'blocked');
});
test('Swarm gates every task and persists verdicts without repeated reviews [AC:collaboration-quality-gates#AC-1] [AC:collaboration-quality-gates#AC-2]', async t => {
  for (const passed of [true, false]) {
    const db = fixture(t), store = db.swarm();
    db.upsertAgent({ id: 'general', name: 'general', role: 'assistant', instructions: 'test', capabilities: [] });
    const run = { id: `run-${passed}`, goal: 'correct output', status: 'pending', strategy: 'pipeline', budget: { maxTeammates: 2, maxTurnsPerAgent: 4, maxDurationMs: 60000 }, qualityGate: ['correct output'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.createRun(run);
    let reviews = 0;
    const executor = new SwarmExecutor({ store, listSessions: () => db.listSessions(), getSession: id => db.getSession(id), createTeammateSession: ({ metadata }) => db.createSession({ title: 'member', mode: 'teammate', agentId: 'general', metadata }), runSession: async id => { db.updateSession(id, { status: 'completed' }); }, enqueueSchedulerWake() {}, sessionTeammateFinished: () => true, reviewTask: async () => { reviews++; return { ...good, passed }; } });
    executor.startRun(run.id, [{ title: 'correct output' }]);
    await executor.tick(); await new Promise(setImmediate); await executor.tick(); await executor.tick();
    assert.equal(store.getRun(run.id).status, passed ? 'completed' : 'failed');
    assert.equal(reviews, 1);
    assert.equal(store.listReviews(run.id)[0].passed, passed);
    assert.match(store.listReviews(run.id)[0].feedback, /verified/);
  }
});

test('Swarm review cannot turn an expired or cancelled run into success [AC:collaboration-quality-gates#AC-1]', async t => {
  for (const mode of ['expired', 'cancelled', 'missing', 'exception']) {
    const db = fixture(t), store = db.swarm(), now = new Date().toISOString();
    const run = { id: mode, goal: 'quality', status: 'running', strategy: 'pipeline', budget: { maxTeammates: 1, maxTurnsPerAgent: 3, maxDurationMs: 60000 }, qualityGate: [], createdAt: now, updatedAt: now };
    store.createRun(run);
    const session = db.createSession({ title: 'finished', mode: 'teammate', agentId: 'general', metadata: { swarmRunId: mode } });
    db.updateSession(session.id, { status: 'completed' });
    store.createTask({ id: `task-${mode}`, swarmRunId: mode, title: 'quality', status: 'in_progress', requiredRole: 'implementer', capabilityTags: [], acceptanceCriteria: [], artifacts: [`session:${session.id}`], blockedBy: [], createdAt: now, updatedAt: now });
    if (mode === 'cancelled') store.createTask({ ...store.listTasks(mode)[0], id: 'second-cancelled' });
    let reviews = 0;
    const reviewTask = mode === 'missing' ? undefined : async () => {
      reviews++;
      if (mode === 'cancelled') store.updateRunStatus(mode, 'cancelled');
      if (mode === 'expired') db.db.prepare('UPDATE swarm_runs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 120000).toISOString(), mode);
      if (mode === 'exception') throw Error('review crashed');
      return good;
    };
    // The expiration is on the captured run as well, as a real long-running await would be.
    if (mode === 'expired') run.budget.maxDurationMs = 1;
    const executor = new SwarmExecutor({ store, listSessions: () => db.listSessions(), getSession: id => db.getSession(id), createTeammateSession() { throw Error('unexpected dispatch'); }, runSession: async () => {}, enqueueSchedulerWake() {}, sessionTeammateFinished: () => true,
      reviewTask: mode === 'expired' ? async () => { await new Promise(r => setTimeout(r, 70)); return good; } : reviewTask });
    if (mode === 'expired') db.db.prepare('UPDATE swarm_runs SET budget = ? WHERE id = ?').run(JSON.stringify({ ...run.budget, maxDurationMs: 60 }), mode);
    await executor.tick();
    assert.equal(store.getRun(mode).status, mode === 'cancelled' ? 'cancelled' : 'failed');
    if (mode === 'cancelled') assert.equal(reviews, 1);
  }
});
