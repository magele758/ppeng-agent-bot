import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { dispatchBotTask, tickBotWork } from '../dist/bots/bot-work.js';
import { createLogger } from '../dist/logger.js';
import { spawnSubagentOutcome } from '../dist/runtime/spawn-host.js';
import { SqliteStateStore } from '../dist/storage.js';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { SwarmStore, createSwarmId, nowIso } from '../dist/swarm/store.js';
import { TeamDagExecutor } from '../dist/teams/executor.js';
import { defaultTeamsDagSettings } from '../dist/teams/settings.js';

function runtime(name, completeText) {
  const root = mkdtempSync(join(tmpdir(), 'goal-conclusion-'));
  return new RawAgentRuntime({
    repoRoot: root,
    stateDir: join(root, 'state'),
    modelAdapter: {
      name,
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Observed result: done' }] };
      },
      async completeText(input) {
        if (completeText) return completeText(input);
        if (String(input.system).startsWith('Evaluate')) {
          return JSON.stringify({ met: true, advanced: true, reason: 'Checked', evidence: ['Observed result: done'] });
        }
        return JSON.stringify({ intents: [{ kind: 'new_goal', text: 'Fix the login form' }] });
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
}

test('子会话结束后等待指向子会话且能读到结果 [AC:bot-goal-conclusion#AC-1]', async () => {
  const rt = runtime('goal-child-wait');
  try {
    const bot = rt.createBot({ name: 'Child wait' });
    const parentId = rt.openBot(bot.id).sessionId;
    rt.sendUserMessage(parentId, '修复登录表单');
    await rt.runHumanSession(parentId);
    const parent = rt.getSession(parentId);
    const service = new BotGoalService(rt.store, Date.now, parentId);
    const goal = service.create({ botId: bot.id, sessionId: parentId, title: 'Child wait', objective: 'Inspect the form again' });
    rt.store.updateSession(parentId, { metadata: { ...rt.getSession(parentId).metadata, botGoalId: goal.id, botGoalScopeSessionId: parentId } });
    const host = {
      store: rt.store,
      runSession: async (id) => {
        rt.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'Child observed the fixed form' }]);
        rt.store.updateSession(id, { status: 'idle', metadata: { ...rt.store.getSession(id).metadata, outcome: { kind: 'completed' } } });
      },
      emitTrace: () => {}
    };
    const outcome = await spawnSubagentOutcome(
      host,
      { repoRoot: rt.repoRoot, stateDir: rt.stateDir, session: parent, agent: rt.store.getAgent(parent.agentId) },
      '检查登录表单是否修好'
    );
    const childId = outcome.metadata?.childSessionId;
    assert.equal(typeof childId, 'string');
    const child = rt.store.getSession(childId);
    assert.equal(child.metadata.botGoalId, goal.id);
    assert.equal(child.metadata.botGoalScopeSessionId, parentId);
    const { createRuntimeGoalDispatchTool } = await import('../dist/bots/goals/runtime-dispatch.js');
    const dispatch = createRuntimeGoalDispatchTool({
      store: rt.store,
      goalHost: rt.goalRuntimeHost(),
      deps: () => ({
        store: rt.store,
        tools: [],
        envApprovalPolicy: undefined,
        maxParallelToolCalls: 1,
        modelAdapter: { name: 'goal-child-wait' },
        stateDir: rt.stateDir,
        emitTrace() {}
      }),
      filePolicy: async () => undefined,
      authorizedTools: () => [{
        name: 'spawn_subagent',
        description: 'spawn',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        async execute() {
          return { ok: true, content: outcome.content, metadata: { childSessionId: childId } };
        }
      }],
      runWorker: undefined
    });
    rt.store.updateSession(parentId, {
      status: 'idle',
      metadata: {
        ...rt.getSession(parentId).metadata,
        botGoalId: goal.id,
        botGoalScopeSessionId: parentId
      }
    });
    const renewed = service.claim(bot.id, goal.id, { strategy: 'subagent', leaseMs: 60_000 });
    assert.ok(renewed, 'queued goal can claim an execution');
    service.updateExecution(bot.id, renewed.id, { sessionId: parentId, runRef: `session:${parentId}` });
    rt.store.updateSession(parentId, { metadata: { ...rt.getSession(parentId).metadata, botGoalExecutionId: renewed.id } });
    const context = { session: rt.getSession(parentId), agent: rt.store.getAgent(parent.agentId), repoRoot: rt.repoRoot, stateDir: rt.stateDir };
    const launched = await dispatch.execute(context, { preferredStrategy: 'subagent', workKind: 'general' });
    assert.equal(launched.ok, true, launched.content);
    const saved = service.executions(bot.id, goal.id).find((item) => item.id === renewed.id);
    assert.equal(saved.runRef, `session:${childId}`);
    const waits = rt.getSession(parentId).metadata.botGoalAuthorizedWaits;
    assert.ok(waits.some((wait) => wait.source === 'session' && wait.correlationId === childId));
    const hostForTick = {
      store: rt.store,
      isRunning: () => false,
      cancel: () => {},
      run: async () => {},
      capabilities: () => ({ registeredTools: ['spawn_subagent'], enabledStrategies: ['direct', 'subagent'] })
    };
    await tickBotGoals(hostForTick);
    const settled = service.get(bot.id, goal.id);
    assert.notEqual(settled.status, 'blocked');
    assert.ok(settled.evidence.some((item) => item.includes('Child observed')) || settled.progress.includes(childId));
  } finally {
    await rt.destroy();
  }
});

test('并发子会话跑完后目标按结果结算而不停在执行中 [AC:bot-goal-conclusion#AC-2]', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const root = mkdtempSync(join(tmpdir(), 'goal-fork-'));
  const rt = new RawAgentRuntime({
    repoRoot: root,
    stateDir: join(root, 'state'),
    modelAdapter: {
      name: 'goal-fork',
      async runTurn(input) {
        const session = rt.store.getSession(input.sessionId);
        if (session?.metadata?.canonicalBotChat === true) await held;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Fork observed the second task' }] };
      },
      async completeText(input) {
        if (String(input.system).startsWith('Evaluate')) {
          return JSON.stringify({ met: true, advanced: true, reason: 'Fork checked', evidence: ['Fork observed the second task'] });
        }
        return JSON.stringify({ intents: [{ kind: 'new_goal', text: input.user }] });
      },
      async summarizeMessages() { return ''; }
    }
  });
  try {
    const bot = rt.createBot({ name: 'Fork settle' });
    const parentId = rt.openBot(bot.id).sessionId;
    rt.sendUserMessage(parentId, '先处理第一件待办');
    const running = rt.runHumanSession(parentId);
    for (let n = 0; n < 50 && !rt.store.getDaemonControl(`bot.goal-intake:${parentId}`); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    rt.sendUserMessage(parentId, '再处理第二件已登记目标');
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await running;
    const service = new BotGoalService(rt.store, Date.now, parentId);
    const goals = service.list(bot.id);
    assert.ok(goals.length >= 1);
    for (let n = 0; n < 40; n++) {
      if (goals.every((goal) => service.get(bot.id, goal.id).status !== 'running')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const settled = service.list(bot.id);
    assert.ok(settled.every((goal) => goal.status !== 'running'), JSON.stringify(settled.map((goal) => goal.status)));
    assert.ok(settled.some((goal) => goal.evidence.some((item) => item.includes('Fork observed')) || goal.progress.includes('Fork observed')));
  } finally {
    release();
    await rt.destroy();
  }
});

test('委托结束后只跟对方任务走，对方内部子会话不是原目标执行 [AC:bot-goal-conclusion#AC-3]', async () => {
  const rt = runtime('goal-delegate', () => JSON.stringify({ intents: [] }));
  try {
    const requester = rt.createBot({ name: 'Requester' });
    const target = rt.createBot({ name: 'Target' });
    const parentId = rt.openBot(requester.id).sessionId;
    const service = new BotGoalService(rt.store, Date.now, parentId);
    const goal = service.create({ botId: requester.id, sessionId: parentId, title: 'Delegate', objective: 'Ask the other bot' });
    const execution = service.claim(requester.id, goal.id, { strategy: 'bot_delegate' });
    service.updateExecution(requester.id, execution.id, { sessionId: parentId });
    const principal = { userId: 'owner' };
    rt.store.updateSession(parentId, { metadata: { ...rt.getSession(parentId).metadata, userId: 'owner' } });
    rt.openBot(target.id, { userId: 'owner' });
    const task = dispatchBotTask({
      store: rt.store,
      runSession: async () => {},
      log: createLogger('goal-delegate-test')
    }, { principal, requesterBotId: requester.id, targetBotId: target.id, input: 'Report the concrete result', idempotencyKey: execution.id });
    const pending = rt.store.db.prepare("SELECT session_id FROM bot_work_messages WHERE task_id=? AND status='pending'").get(task.id);
    const targetSession = rt.store.getSession(pending.session_id);
    assert.ok(targetSession, 'delegated task has a target session');
    const { drainBotSession } = await import('../dist/bots/bot-work.js');
    const work = { store: rt.store, runSession: async () => {}, isSessionRunning: () => false, log: createLogger('goal-delegate-test') };
    assert.equal(drainBotSession(work, targetSession.id), true);
    const claimed = rt.store.getSession(targetSession.id);
    assert.ok(claimed, 'target session records the delegated task');
    const internal = await spawnSubagentOutcome({
      store: rt.store,
      runSession: async (id) => {
        rt.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'internal note' }]);
      }
    }, {
      repoRoot: rt.repoRoot,
      stateDir: rt.stateDir,
      session: claimed,
      agent: rt.store.getAgent(claimed.agentId)
    }, 'internal step');
    const internalSession = rt.store.getSession(internal.metadata.childSessionId);
    assert.equal(internalSession.metadata.botWorkTaskId, task.id);
    assert.notEqual(internalSession.metadata.botGoalId, goal.id);
    const host = {
      store: rt.store,
      isRunning: () => false,
      cancel: () => {},
      run: async () => {},
      capabilities: () => ({ registeredTools: [], enabledStrategies: ['bot_delegate'] })
    };
    rt.store.updateSession(parentId, { metadata: { ...rt.getSession(parentId).metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, source: 'bot_task', correlationId: task.id }] } });
    service.report(requester.id, execution.id, { kind: 'waiting', summary: 'waiting on the other bot', wait: { source: 'bot_task', correlationId: task.id } });
    rt.store.db.prepare("UPDATE bot_work_tasks SET status='completed', result=? WHERE id=?").run('Target reported the form is fixed', task.id);
    await tickBotGoals(host);
    const settled = service.get(requester.id, goal.id);
    assert.notEqual(settled.status, 'waiting');
    assert.ok(settled.evidence.some((item) => item.includes('Target reported')) || settled.progress.includes('Target reported'));
    assert.equal(internalSession.parentSessionId, claimed.id);
    assert.ok(!service.executions(requester.id, goal.id).some((item) => item.sessionId === internal.metadata.childSessionId));
  } finally {
    await rt.destroy();
  }
});

test('成员失败或空群体执行进入失败终态且不误唤醒父目标 [AC:bot-goal-conclusion#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-fanout-'));
  const sqlite = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const plans = sqlite.teams();
    const sessions = [];
    const wakes = [];
    const executor = new TeamDagExecutor({
      store: plans,
      settings: () => defaultTeamsDagSettings(),
      stateDir: dir,
      sourceRoot: dir,
      listSessions: () => sessions,
      getSession: (id) => sessions.find((session) => session.id === id),
      createTeammateSession: (input) => {
        const session = { id: 'failed-member', agentId: 'worker', status: 'failed', metadata: input.metadata ?? {}, prompt: input.prompt };
        sessions.push(session);
        return session;
      },
      createTask: (input) => ({ id: `task-${input.title.slice(0, 8)}` }),
      bindWorkspaceForTask: async () => undefined,
      createMail: () => {},
      runSession: async () => {},
      enqueueSchedulerWake: (...args) => wakes.push(args),
      sessionTeammateFinished: () => false
    });
    const created = await executor.createPlan({ objective: 'Write report', tasks: [{ id: 'a', title: 'A', role: 'worker', dependsOn: [] }] });
    executor.start(created.plan.id);
    await executor.tick();
    await executor.tick();
    const plan = plans.get(created.plan.id);
    assert.equal(plan.tasks[0].status, 'failed');
    assert.equal(plan.status, 'failed');

    const swarmStore = new SwarmStore(sqlite.db);
    const swarm = new SwarmExecutor({
      store: swarmStore,
      listSessions: () => [],
      getSession: () => undefined,
      createTeammateSession: () => { throw new Error('no teammate'); },
      runSession: async () => { throw new Error('launch failed'); },
      enqueueSchedulerWake: () => {},
      sessionTeammateFinished: () => false
    });
    const emptyId = createSwarmId('srun');
    swarmStore.createRun({ id: emptyId, goal: 'empty', status: 'pending', strategy: 'pipeline', budget: { maxTeammates: 2, maxTurnsPerAgent: 1, maxDurationMs: 60_000 }, qualityGate: [], createdAt: nowIso(), updatedAt: nowIso() });
    swarm.startRun(emptyId, []);
    await swarm.tick();
    assert.equal(swarmStore.getRun(emptyId).status, 'failed');

    const parent = sqlite.createSession({ title: 'Bot', mode: 'chat', agentId: 'general', metadata: { canonicalBotChat: true, botId: 'b', userId: 'owner' } });
    const service = new BotGoalService(sqlite, Date.now, parent.id);
    const goal = service.create({ botId: 'b', sessionId: parent.id, title: 'Fanout', objective: 'Fan out' });
    const execution = service.claim('b', goal.id, { strategy: 'swarm' });
    service.updateExecution('b', execution.id, { sessionId: parent.id });
    sqlite.updateSession(parent.id, { metadata: { ...parent.metadata, botGoalAuthorizedWaits: [{ goalId: goal.id, source: 'swarm', correlationId: 'missing-run' }] } });
    service.report('b', execution.id, { kind: 'waiting', summary: 'waiting', wait: { source: 'swarm', correlationId: 'missing-run' } });
    const runs = [];
    await tickBotGoals({ store: sqlite, isRunning: () => false, cancel: () => {}, run: async (id) => { runs.push(id); }, capabilities: () => ({ registeredTools: [], enabledStrategies: ['swarm'] }) });
    assert.equal(runs.length, 0);
    assert.notEqual(service.get('b', goal.id).status, 'queued');
    assert.equal(wakes.length, 1);
  } finally {
    sqlite.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完成判官抛错时已完成回合保持待核对而不阻塞 [AC:bot-goal-conclusion#AC-5]', async () => {
  const rt = runtime('goal-judge', (input) => {
    if (String(input.system).startsWith('Evaluate')) throw new Error('judge unavailable');
    return JSON.stringify({ intents: [{ kind: 'new_goal', text: 'Calculate two plus two' }] });
  });
  try {
    const bot = rt.createBot({ name: 'Judge down' });
    const parentId = rt.openBot(bot.id).sessionId;
    rt.sendUserMessage(parentId, 'Calculate two plus two');
    await rt.runHumanSession(parentId);
    const service = new BotGoalService(rt.store, Date.now, parentId);
    const goal = service.list(bot.id)[0];
    assert.notEqual(goal.status, 'blocked');
    assert.equal(goal.status, 'queued');
    assert.ok(goal.evidence.some((item) => item.includes('Observed result')) || goal.progress.includes('Observed result'));
  } finally {
    await rt.destroy();
  }
});
