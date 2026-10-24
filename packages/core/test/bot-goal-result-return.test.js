import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { settleGoalExecution } from '../dist/bots/goals/runtime-host.js';
import { applyConcurrentBotForks } from '../dist/bots/concurrent-fork.js';
import { createRuntimeGoalDispatchTool } from '../dist/bots/goals/runtime-dispatch.js';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { TeamDagExecutor } from '../dist/teams/executor.js';
import { defaultTeamsDagSettings } from '../dist/teams/settings.js';
import { dispatchBotTask, resolveBotPrincipal } from '../dist/bots/bot-work.js';
import { createBot } from '../dist/bots/bot-facade.js';
import { createSwarmId, nowIso } from '../dist/swarm/store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-return-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = store.createSession({ title: 'Bot', mode: 'chat', agentId: 'general', metadata: { canonicalBotChat: true, botId: 'b', permissionMode: 'ask', allowedTools: ['read_file', 'spawn_subagent'], userId: 'owner' } });
  const service = new BotGoalService(store, Date.now, parent.id);
  const runs = [];
  const running = new Set();
  const host = {
    store,
    isRunning: id => running.has(id),
    cancel: id => { running.delete(id); },
    run: id => { runs.push(id); running.add(id); return new Promise(() => {}); },
    capabilities: () => ({ registeredTools: ['spawn_subagent', 'read_file'], enabledStrategies: ['direct', 'subagent'] })
  };
  const create = (extra = {}) => service.create({ botId: 'b', sessionId: parent.id, title: 'Fix', objective: 'Fix the reported defect', ...extra });
  return { dir, store, parent, service, host, create, runs, running };
}

function fixtureHost(store) {
  return { store, isRunning: () => false, cancel() {}, run: async () => {} };
}
function waitOn(service, store, parent, goal, source, correlationId) {
  const execution = service.claim('b', goal.id, { strategy: source === 'session' ? 'subagent' : source });
  service.updateExecution('b', execution.id, { sessionId: parent.id });
  const live = store.getSession(parent.id);
  store.updateSession(parent.id, { metadata: { ...live.metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, source, correlationId, executionId: execution.id }] } });
  service.report('b', execution.id, { kind: 'waiting', summary: 'wait', wait: { source, correlationId } });
  return execution;
}

test('finished child session returns its result to the parent goal [AC:bot-goal-result-return#AC-1]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  const goal = create();
  const child = store.createSession({ title: 'worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.updateSession(child.id, { status: 'idle', metadata: { ...store.getSession(child.id).metadata, outcome: { kind: 'completed' } } });
  store.appendMessage(child.id, 'assistant', [{ type: 'text', text: 'Observed build result: passed' }]);
  waitOn(service, store, parent, goal, 'session', child.id);
  await tickBotGoals(host);
  const saved = service.get('b', goal.id);
  assert.notEqual(saved.status, 'blocked');
  assert.ok(saved.evidence.some(item => item.includes('build result')));
  assert.equal(runs.length, 1);
  assert.equal(store.getSession(runs[0]).metadata.botGoalId, goal.id);
});

test('a subagent spawned for a goal keeps the parent goal identity [AC:bot-goal-result-return#AC-1]', async t => {
  const { store, parent, service, create, dir } = fixture(t);
  const { spawnSubagentOutcome } = await import('../dist/runtime/spawn-host.js');
  const goal = create();
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: parent.id });
  store.updateSession(parent.id, { metadata: { ...store.getSession(parent.id).metadata, botGoalId: goal.id, botGoalExecutionId: execution.id, botGoalScopeSessionId: parent.id } });
  const host = {
    store, repoRoot: dir, stateDir: dir, workspaceManager: {}, sandbox: undefined, setSandbox() {}, backgroundJobAborts: new Map(),
    async runSession(id) { return store.getSession(id); }
  };
  const parentSession = store.getSession(parent.id);
  await spawnSubagentOutcome(host, { repoRoot: dir, stateDir: dir, session: parentSession, agent: { id: 'general', role: 'general' } }, 'Finish the defect');
  const child = store.listSessions().find(session => session.parentSessionId === parent.id && session.mode === 'subagent');
  assert.equal(child.metadata.botGoalId, goal.id);
  assert.equal(child.metadata.botGoalScopeSessionId, parent.id);
});

test('dispatch records the spawned child as the goal wait [AC:bot-goal-result-return#AC-1]', async t => {
  const { store, parent, service, create, dir } = fixture(t);
  const goal = create();
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: parent.id, runRef: `session:${parent.id}` });
  store.updateSession(parent.id, { metadata: { ...store.getSession(parent.id).metadata, permissionMode: 'auto', botGoalId: goal.id, botGoalExecutionId: execution.id } });
  const spawn = {
    name: 'spawn_subagent', description: 'spawn', inputSchema: { type: 'object' }, approvalMode: 'never', sideEffectLevel: 'none',
    async execute() {
      const child = store.createSession({ title: 'spawned', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
      return { ok: true, content: 'child finished', metadata: { childSessionId: child.id } };
    }
  };
  const tool = createRuntimeGoalDispatchTool({
    store,
    goalHost: { store, isRunning: () => false, cancel() {}, run: async () => {}, capabilities: () => ({ registeredTools: ['spawn_subagent'], allowedTools: ['spawn_subagent'], enabledStrategies: ['subagent'], ptcEnabled: false, hasWorkspace: true }) },
    deps: () => ({ store, tools: [spawn], maxParallelToolCalls: 1, modelAdapter: { name: 'fixture' }, stateDir: dir, emitTrace() {} }),
    filePolicy: async () => undefined,
    authorizedTools: () => [spawn]
  });
  const result = await tool.execute({ session: store.getSession(parent.id), agent: { id: 'general', instructions: '', capabilities: [] }, repoRoot: dir, stateDir: dir }, { preferredStrategy: 'subagent' });
  if (!result.ok) assert.fail(result.content);
  assert.equal(result.ok, true);
  const saved = service.executions('b', goal.id)[0];
  const child = store.listSessions().find(session => session.id !== parent.id);
  assert.equal(saved.runRef, `session:${child.id}`);
  assert.equal(store.getSession(parent.id).metadata.botGoalCheckpoint.wait.correlationId, child.id);
});

test('a finished forked child settles its goal instead of leaving it running [AC:bot-goal-result-return#AC-2]', async t => {
  const { store, parent, service, host, create } = fixture(t);
  const goal = create();
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  store.appendMessage(parent.id, 'user', [{ type: 'text', text: 'keep this on the parent' }]);
  store.appendMessage(parent.id, 'user', [{ type: 'text', text: 'fork this extra piece' }]);
  const messages = store.foldMessages(parent.id).filter(message => message.role === 'user');
  store.setDaemonControl(`session.humanContinuation:${parent.id}`, { pending: messages.map(message => ({ id: message.id, seq: 1 })) });
  store.setDaemonControl(`bot.goal-intake:${parent.id}`, { [messages[1].id]: goal.id });
  let settled;
  const forkHost = {
    store,
    async runSession(id) {
      store.appendMessage(id, 'assistant', [{ type: 'text', text: 'fork result recorded' }]);
      store.updateSession(id, { status: 'idle', metadata: { ...store.getSession(id).metadata, outcome: { kind: 'completed' }, botGoalExecutionId: execution.id } });
      service.updateExecution('b', execution.id, { sessionId: id });
      settled = id;
      return store.getSession(id);
    },
    log: { warn() {} }
  };
  const created = applyConcurrentBotForks(forkHost, parent.id, true);
  assert.equal(created.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, created[0]);
  await settleGoalExecution({ ...host, judge: async () => { throw new Error('judge down'); } }, settled);
  const saved = service.get('b', goal.id);
  assert.notEqual(saved.status, 'running');
  assert.ok(saved.evidence.join('\n').includes('fork result recorded') || saved.progress.includes('fork result'));
});

test('an idle finished execution is reported instead of staying running [AC:bot-goal-result-return#AC-2]', async t => {
  const { host, create, service, store, parent } = fixture(t);
  const goal = create();
  const child = store.createSession({ title: 'done worker', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
  store.appendMessage(child.id, 'assistant', [{ type: 'text', text: 'patch applied' }]);
  store.updateSession(child.id, { status: 'idle', metadata: { ...store.getSession(child.id).metadata, outcome: { kind: 'completed' } } });
  const execution = service.claim('b', goal.id, { strategy: 'subagent' });
  service.updateExecution('b', execution.id, { sessionId: child.id });
  await tickBotGoals(host);
  assert.notEqual(service.get('b', goal.id).status, 'running');
  assert.equal(service.executions('b', goal.id)[0].status, 'finished');
});

test('a late approval decision still resumes or blocks the same execution [AC:bot-goal-result-return#AC-2]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  for (const decision of ['approved', 'rejected']) {
    const goal = create();
    const child = store.createSession({ title: 'approval', mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id } });
    const execution = service.claim('b', goal.id, { strategy: 'swarm', leaseMs: 60000 });
    service.updateExecution('b', execution.id, { sessionId: child.id });
    const snapshot = store.getDaemonControl(`bot_goals:b`);
    const row = snapshot.executions.find(item => item.id === execution.id);
    row.leaseUntil = Date.now() - 1000;
    store.setDaemonControl(`bot_goals:b`, snapshot);
    store.updateSession(child.id, { status: 'idle', metadata: { ...store.getSession(child.id).metadata, botGoalExecutionId: execution.id, botGoalDispatch: { executionId: execution.id, request: { preferredStrategy: 'swarm' }, result: { waitingApproval: true } } } });
    store.setDaemonControl(`bot.goal-tool-ledger:${child.id}:${execution.id}`, [{ role: 'assistant', parts: [{ type: 'tool_call', toolCallId: `${execution.id}:launch`, name: 'launch', input: { run: goal.id } }] }, { role: 'tool', parts: [{ type: 'tool_result', toolCallId: `${execution.id}:launch`, name: 'launch', ok: false, content: JSON.stringify({ status: 'goal_dispatch_waiting_approval', tool: 'launch' }) }] }]);
    const approval = store.createApproval({ sessionId: child.id, toolName: 'launch', reason: 'Launch requires approval', args: { run: goal.id } });
    store.updateApproval(approval.id, decision);
    await tickBotGoals(host);
    if (decision === 'approved') {
      assert.ok(runs.includes(child.id));
      assert.equal(service.get('b', goal.id).activeExecutionId, execution.id);
    } else {
      assert.equal(service.get('b', goal.id).status, 'blocked');
    }
  }
});

test('delegated bot child results return to the original goal [AC:bot-goal-result-return#AC-3]', async t => {
  const { service, store, parent, dir } = fixture(t);
  const { createBotManagementTools } = await import('../dist/bots/bot-work.js');
  const { spawnSubagentOutcome } = await import('../dist/runtime/spawn-host.js');
  const botHost = { store, createChatSession: input => store.createSession(input), log: { warn() {}, info() {}, debug() {}, error() {} }, runSession: () => new Promise(() => {}), isSessionRunning: () => false, cancelSession() {} };
  const requester = createBot(botHost, { name: 'Requester' });
  store.updateSession(parent.id, { metadata: { ...store.getSession(parent.id).metadata, botId: requester.id } });
  const goal = service.create({ botId: requester.id, sessionId: parent.id, title: 'Fix', objective: 'Fix the reported defect' });
  const execution = service.claim(requester.id, goal.id, { strategy: 'bot_delegate' });
  service.updateExecution(requester.id, execution.id, { sessionId: parent.id });
  store.updateSession(parent.id, { metadata: { ...store.getSession(parent.id).metadata, botGoalId: goal.id, botGoalExecutionId: execution.id, botGoalScopeSessionId: parent.id } });
  const target = createBot(botHost, { name: 'Peer' });
  const delegate = createBotManagementTools(botHost).find(tool => tool.name === 'bot_delegate');
  const delegated = await delegate.execute({ session: store.getSession(parent.id), agent: { id: requester.id } }, { target: target.id, input: 'do the work', idempotencyKey: execution.id });
  assert.equal(delegated.ok, true);
  const taskId = JSON.parse(delegated.content).id;
  const peerChat = store.listSessions().find(session => session.metadata?.botId === target.id && session.metadata?.botWorkTaskId === taskId && session.metadata?.canonicalBotChat === true);
  assert.equal(peerChat.metadata.botGoalId, undefined);
  assert.equal(peerChat.metadata.botDelegatedGoal.id, goal.id);
  assert.equal(peerChat.metadata.botDelegatedGoal.sessionId, parent.id);
  const spawnHost = { store, repoRoot: dir, stateDir: dir, workspaceManager: {}, sandbox: undefined, setSandbox() {}, backgroundJobAborts: new Map(), async runSession(id) {
    store.appendMessage(id, 'assistant', [{ type: 'text', text: 'peer child evidence' }]);
    store.updateSession(id, { status: 'idle', metadata: { ...store.getSession(id).metadata, outcome: { kind: 'completed' } } });
    return store.getSession(id);
  } };
  await spawnSubagentOutcome(spawnHost, { repoRoot: dir, stateDir: dir, session: peerChat, agent: { id: 'general', role: 'general' } }, 'Finish the delegated work');
  const peerChild = store.listSessions().find(session => session.parentSessionId === peerChat.id);
  assert.equal(peerChild.metadata.botGoalId, undefined);
  assert.equal(peerChild.metadata.botDelegatedGoal.id, goal.id);
  assert.equal(peerChild.metadata.botDelegatedGoal.sessionId, parent.id);
  assert.equal(peerChild.metadata.botWorkTaskId, taskId);
  const taskRow = store.db.prepare('SELECT status FROM bot_work_tasks WHERE id=?').get(taskId);
  assert.equal(['queued', 'running', 'waiting_approval'].includes(taskRow.status), true);
  const live = store.getSession(parent.id);
  store.updateSession(parent.id, { metadata: { ...live.metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, source: 'bot_task', correlationId: taskId, executionId: execution.id }] } });
  service.report(requester.id, execution.id, { kind: 'waiting', summary: 'wait', wait: { source: 'bot_task', correlationId: taskId } });
  await tickBotGoals({ ...fixtureHost(store), capabilities: () => ({ registeredTools: ['bot_delegate'], enabledStrategies: ['direct', 'bot_delegate'] }) });
  const saved = service.get(requester.id, goal.id);
  assert.notEqual(saved.status, 'blocked');
  assert.notEqual(saved.status, 'waiting');
  assert.ok(saved.evidence.some(item => item.includes('peer child evidence')));

  const mismatch = service.create({ botId: requester.id, sessionId: parent.id, title: 'Mismatch', objective: 'Fix the reported defect' });
  const outsider = createBot(botHost, { name: 'Outsider' });
  const principal = resolveBotPrincipal(store, { userId: 'owner' });
  const foreign = dispatchBotTask(botHost, { principal, requesterBotId: outsider.id, targetBotId: target.id, input: 'not ours' });
  store.db.prepare("UPDATE bot_work_tasks SET status='completed', result=? WHERE id=?").run('foreign', foreign.id);
  const foreignExecution = service.claim(requester.id, mismatch.id, { strategy: 'bot_delegate' });
  service.updateExecution(requester.id, foreignExecution.id, { sessionId: parent.id });
  const again = store.getSession(parent.id);
  store.updateSession(parent.id, { metadata: { ...again.metadata, botGoalAuthorizedWaits: [...(again.metadata.botGoalAuthorizedWaits ?? []), { goalId: mismatch.id, source: 'bot_task', correlationId: foreign.id, executionId: foreignExecution.id }] } });
  service.report(requester.id, foreignExecution.id, { kind: 'waiting', summary: 'wait', wait: { source: 'bot_task', correlationId: foreign.id } });
  await tickBotGoals({ ...fixtureHost(store), capabilities: () => ({ registeredTools: ['bot_delegate'], enabledStrategies: ['direct', 'bot_delegate'] }) });
  assert.equal(service.get(requester.id, mismatch.id).status, 'blocked');
});

test('team and swarm fan-out close the parent goal on failure and missing runs do not wake [AC:bot-goal-result-return#AC-4] [AC:ci-action-reliability#AC-2]', async t => {
  const { host, create, service, store, parent, dir, runs } = fixture(t);
  const sessions = [];
  const swarm = new SwarmExecutor({
    store: store.swarm(),
    listSessions: () => sessions,
    getSession: id => sessions.find(session => session.id === id),
    createTeammateSession: () => { throw new Error('launch failed'); },
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false
  });
  const stamp = nowIso();
  const runId = createSwarmId('srun');
  store.swarm().createRun({ id: runId, goal: 'work', status: 'running', strategy: 'pipeline', budget: { maxTeammates: 2, maxTurnsPerAgent: 4, maxDurationMs: 60_000 }, qualityGate: [], createdAt: stamp, updatedAt: stamp });
  store.swarm().createTask({ id: createSwarmId('stask'), swarmRunId: runId, title: 'Do work', status: 'pending', requiredRole: 'implementer', capabilityTags: [], acceptanceCriteria: [], artifacts: [], blockedBy: [], createdAt: stamp, updatedAt: stamp });
  await swarm.tick();
  assert.equal(store.swarm().getRun(runId).status, 'failed');

  const emptyId = createSwarmId('srun');
  store.swarm().createRun({ id: emptyId, goal: 'empty', status: 'running', strategy: 'pipeline', budget: { maxTeammates: 2, maxTurnsPerAgent: 4, maxDurationMs: 60_000 }, qualityGate: [], createdAt: stamp, updatedAt: stamp });
  await swarm.tick();
  assert.equal(store.swarm().getRun(emptyId).status, 'failed');

  const team = new TeamDagExecutor({
    store: store.teams(),
    settings: () => defaultTeamsDagSettings(),
    stateDir: dir,
    sourceRoot: dir,
    listSessions: () => sessions,
    getSession: id => sessions.find(session => session.id === id),
    createTeammateSession: input => {
      const session = { id: 'team-worker', agentId: 'worker', status: 'failed', metadata: input.metadata, parentSessionId: parent.id };
      sessions.push(session);
      return session;
    },
    createTask: input => ({ id: `task-${input.title.slice(0, 8)}` }),
    bindWorkspaceForTask: async () => undefined,
    createMail: () => {},
    runSession: async () => { throw new Error('team run failed'); },
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false
  });
  const created = await team.createPlan({ objective: 'Write report', sessionId: parent.id, tasks: [{ id: 'a', title: 'A', role: 'worker', dependsOn: [] }] });
  team.start(created.plan.id);
  await team.tick();
  await team.tick();
  assert.equal(store.teams().get(created.plan.id).status, 'failed');
  assert.equal(store.teams().get(created.plan.id).tasks[0].status, 'failed');

  for (const source of ['swarm', 'team_dag']) {
    const missing = create({ title: `Missing ${source}` });
    waitOn(service, store, parent, missing, source, 'missing-run');
    await tickBotGoals(host);
    assert.equal(service.get('b', missing.id).status, 'blocked');
    assert.match(service.get('b', missing.id).blockedReason, /missing/);
  }
  assert.equal(runs.length, 0);
});

test('a finished turn keeps its result when verification is unavailable [AC:bot-goal-result-return#AC-5]', async t => {
  const { store, parent, service, create, host } = fixture(t);
  const goal = create();
  const execution = service.claim('b', goal.id, { strategy: 'direct' });
  service.updateExecution('b', execution.id, { sessionId: parent.id });
  store.appendMessage(parent.id, 'assistant', [{ type: 'text', text: 'tests passed on the fix' }]);
  const live = store.getSession(parent.id);
  store.updateSession(parent.id, {
    status: 'idle',
    metadata: {
      ...live.metadata,
      botGoalId: goal.id,
      botGoalExecutionId: execution.id,
      botGoalCheckpoint: { kind: 'candidate_completed', summary: 'tests passed on the fix', evidence: ['tests passed on the fix'], verified: false },
      outcome: { kind: 'completed' }
    }
  });
  await settleGoalExecution({ ...host, judge: async () => { throw new Error('judge down'); } }, parent.id);
  const saved = service.get('b', goal.id);
  assert.notEqual(saved.status, 'blocked');
  assert.ok(saved.evidence.some(item => item.includes('tests passed')) || saved.progress.includes('tests passed'));
});

test('factory and evolution results return without a specialty inspector [AC:bot-goal-result-return#AC-5]', async t => {
  const { host, create, service, store, parent, runs } = fixture(t);
  for (const source of ['factory', 'evolution']) {
    const goal = create({ title: source });
    const worker = store.createSession({ title: `${source} worker`, mode: 'subagent', agentId: 'general', parentSessionId: parent.id, metadata: { [`${source}RunId`]: `${source}-1`, botId: 'b' } });
    store.appendMessage(worker.id, 'assistant', [{ type: 'text', text: `${source} output recorded` }]);
    store.updateSession(worker.id, { status: 'idle', metadata: { ...store.getSession(worker.id).metadata, outcome: { kind: 'completed' } } });
    waitOn(service, store, parent, goal, source, `${source}-1`);
    await tickBotGoals(host);
    const saved = service.get('b', goal.id);
    assert.notEqual(saved.status, 'blocked');
    assert.notEqual(saved.status, 'waiting');
    assert.ok(saved.evidence.some(item => item.includes(`${source} output recorded`)));
  }
  assert.equal(runs.length, 2);
  const unsupported = create({ title: 'mystery' });
  waitOn(service, store, parent, unsupported, 'unsupported', 'x');
  await tickBotGoals(host);
  assert.equal(service.get('b', unsupported.id).status, 'blocked');
});
