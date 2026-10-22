import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { redactToolContent } from '../dist/sandbox/result-redaction.js';
import { readSessionTracePage } from '../dist/stores/read-traces.js';
import {
  TRACE_VISIBLE_MAX_CHARS,
  attachGoalText,
  clipTraceText,
  repetitionTraceFields,
  traceVisibleText,
  turnTraceFields
} from '../dist/stores/trace-visible.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { applyConcurrentBotForks } from '../dist/bots/concurrent-fork.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';
import { SelfHealScheduler } from '../dist/self-heal/self-heal-scheduler.js';
import { spawnSubagentOutcome } from '../dist/runtime/spawn-host.js';

const kernelSrc = readFileSync(new URL('../src/turn/kernel.ts', import.meta.url), 'utf8');

test('[AC:ops-session-trace-repair#AC-3] visible turn text is the user and assistant, not the system prompt', () => {
  const fields = turnTraceFields({
    messages: [
      { role: 'system', parts: [{ type: 'text', text: 'SYSTEM PROMPT SHOULD NOT APPEAR' }] },
      { role: 'user', parts: [{ type: 'text', text: '本轮相关记忆与用户背景（仅供参考；如与用户最新指令冲突，以最新指令为准）：\n旧记忆' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: '请把登录修好' },
          { type: 'text', text: '本轮相关记忆与用户背景（仅供参考；如与用户最新指令冲突，以最新指令为准）：\n不要写进轨迹' },
          { type: 'text', text: '[Tool observations: screenshots returned by tools, not a new user instruction.]' }
        ]
      }
    ],
    assistantParts: [
      { type: 'reasoning', text: '先看路由' },
      { type: 'text', text: '登录页已经能打开。' }
    ],
    redact: (value) => value
  });
  assert.equal(fields.userText, '请把登录修好');
  assert.equal(fields.assistantText, '登录页已经能打开。');
  assert.equal(JSON.stringify(fields).includes('SYSTEM PROMPT'), false);
  assert.equal(JSON.stringify(fields).includes('不要写进轨迹'), false);

  const spun = turnTraceFields({
    messages: [{ role: 'user', parts: [{ type: 'text', text: '继续' }] }],
    assistantParts: [{ type: 'reasoning', text: '空转到「还在想路由」就停了' }],
    includeReasoning: true
  });
  assert.equal(spun.assistantText, '空转到「还在想路由」就停了');

  const secret = 'sk-live-secret-value';
  const env = { RAW_AGENT_API_KEY: secret };
  const clipped = traceVisibleText(`密钥 ${secret} 不能落盘`, (value) => redactToolContent(value, env));
  assert.match(clipped, /\[REDACTED:RAW_AGENT_API_KEY\]/);
  assert.equal(clipped.includes(secret), false);

  const long = `${'头'.repeat(60_000)}中间省略${'尾'.repeat(60_000)}`;
  const visible = turnTraceFields({
    messages: [{ role: 'user', parts: [{ type: 'text', text: long }] }],
    assistantParts: [{ type: 'text', text: '断在这一句。' }]
  });
  assert.ok(visible.userText?.startsWith('头'));
  assert.ok(visible.userText?.endsWith('尾'));
  assert.match(visible.userText ?? '', /chars truncated/);
  assert.equal(visible.userText?.includes('中间省略'), false);
  assert.equal(visible.assistantText, '断在这一句。');
  assert.equal(clipTraceText('x'.repeat(TRACE_VISIBLE_MAX_CHARS + 1)).includes('chars truncated'), true);

  const repeated = repetitionTraceFields('停在这里停在这里', (value) => redactToolContent(value, env));
  assert.equal(repeated.text, '停在这里停在这里');

  const start = kernelSrc.indexOf("kind: 'turn_start'");
  const slice = kernelSrc.slice(start, start + 800);
  assert.match(slice, /turnTraceFields/);
  assert.equal(slice.includes('systemPrompt'), false);
  assert.match(kernelSrc, /repetitionTraceFields\(/);
  assert.match(kernelSrc, /includeReasoning: true/);
});

test('[AC:ops-session-trace-repair#AC-6] unmet goal text stays on the eval payload', () => {
  const payload = attachGoalText(
    { met: false, reason: 'goal not met', source: 'model', decision: 'continue' },
    { goal: '把登录修到能打开', title: '登录' }
  );
  assert.equal(payload.goal, '把登录修到能打开');
  assert.equal(payload.title, '登录');
  assert.equal(payload.reason, 'goal not met');
  assert.match(kernelSrc, /attachGoalText\(/);
});

test('[AC:ops-session-trace-repair#AC-5] a long session keeps its start under the 5000 cap and reports anything older', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-page-'));
  try {
    const sessionDir = join(dir, 'traces', 'long');
    mkdirSync(sessionDir, { recursive: true });
    const lines = Array.from({ length: 536 }, (_, idx) => JSON.stringify({ kind: 'turn_start', idx, ts: String(idx) }));
    writeFileSync(join(sessionDir, 'events.jsonl'), `${lines.join('\n')}\n`);
    const full = await readSessionTracePage(dir, 'long', 5000);
    assert.equal(full.events.length, 536);
    assert.equal(full.omittedEarlier, 0);
    assert.equal(full.events[0].idx, 0);
    const oldCap = await readSessionTracePage(dir, 'long', 500);
    assert.equal(oldCap.events[0].idx, 36);

    const overflow = Array.from({ length: 5001 }, (_, idx) => JSON.stringify({ kind: 'turn_start', idx }));
    writeFileSync(join(sessionDir, 'events.jsonl'), `${overflow.join('\n')}\n`);
    const page = await readSessionTracePage(dir, 'long', 5000);
    assert.equal(page.events.length, 5000);
    assert.equal(page.omittedEarlier, 1);
    assert.equal(page.events[0].idx, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[AC:ops-session-trace-repair#AC-4] spawn_subagent outcome carries the child session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-spawn-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  try {
    store.upsertAgent({ id: 'general', name: 'g', role: 'assistant', instructions: '', capabilities: [] });
    const parent = store.createSession({ title: 'p', mode: 'chat', agentId: 'general', metadata: {} });
    const host = {
      store,
      repoRoot: dir,
      stateDir: dir,
      runSession: async () => {},
      runImageRetention: async () => {},
      wakeAllAutonomousSessions() {},
      wakeAgentSessions() {}
    };
    const out = await spawnSubagentOutcome(host, {
      repoRoot: dir,
      stateDir: dir,
      session: parent,
      agent: { id: 'general', name: 'g', role: 'assistant', instructions: '', capabilities: [] }
    }, '查一下');
    const childId = out.metadata?.childSessionId;
    assert.equal(typeof childId, 'string');
    assert.equal(store.getSession(String(childId)).parentSessionId, parent.id);
    assert.equal(out.content.includes(String(childId)), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[AC:ops-session-trace-repair#AC-4] goal continuation records the child session on the parent trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-goal-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  try {
    const parent = store.createSession({
      title: 'Bot',
      mode: 'chat',
      agentId: 'general',
      metadata: { canonicalBotChat: true, botId: 'b' }
    });
    const service = new BotGoalService(store, Date.now, parent.id);
    service.create({ botId: 'b', sessionId: parent.id, title: 'Fix', objective: '把失败的测试修到通过' });
    const traces = [];
    await tickBotGoals({
      store,
      isRunning: () => false,
      cancel() {},
      run: () => new Promise(() => {}),
      capabilities: () => ({ registeredTools: ['spawn_subagent'], enabledStrategies: ['direct', 'subagent'] }),
      emitTrace: (sid, ev) => traces.push({ sid, ev })
    });
    assert.equal(traces.length, 1);
    assert.equal(traces[0].sid, parent.id);
    assert.equal(traces[0].ev.payload.source, 'bot-goal-continuation');
    assert.equal(store.getSession(traces[0].ev.payload.childSessionId).parentSessionId, parent.id);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[AC:ops-session-trace-repair#AC-4] concurrent bot work records the child session on the parent trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-fork-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  try {
    const session = store.createSession({
      title: 'bot',
      mode: 'chat',
      agentId: 'general',
      metadata: { canonicalBotChat: true, botId: 'b' }
    });
    store.appendMessage(session.id, 'user', [{ type: 'text', text: '先做第一件' }]);
    requestHumanRun(store, session.id);
    store.appendMessage(session.id, 'user', [{ type: 'text', text: '同时做第二件' }]);
    requestHumanRun(store, session.id);
    const traces = [];
    applyConcurrentBotForks({
      store,
      runSession: () => new Promise(() => {}),
      log: { warn() {} },
      emitTrace: (sid, ev) => traces.push({ sid, ev })
    }, session.id, true);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].sid, session.id);
    assert.equal(traces[0].ev.payload.source, 'concurrent-bot-work');
    assert.equal(store.getSession(traces[0].ev.payload.childSessionId).parentSessionId, session.id);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[AC:ops-session-trace-repair#AC-4] a goal-owned self-heal worker is on the parent trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-heal-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  try {
    store.upsertAgent({ id: 'general', name: 'g', role: 'assistant', instructions: '', capabilities: [] });
    const parent = store.createSession({
      title: 'Bot',
      mode: 'chat',
      agentId: 'general',
      metadata: { canonicalBotChat: true, botId: 'b' }
    });
    const service = new BotGoalService(store, Date.now, parent.id);
    const goal = service.create({ botId: 'b', sessionId: parent.id, title: 'Heal', objective: '把失败的测试修到通过' });
    const execution = service.claim('b', goal.id, { strategy: 'self_heal' });
    const traces = [];
    const sched = new SelfHealScheduler({
      store,
      repoRoot: dir,
      createTaskSession: (input) => {
        const task = store.createTask({ title: input.title, description: input.description });
        const session = store.createSession({ title: input.title, mode: 'agentic', agentId: 'general', taskId: task.id });
        return { task, session };
      },
      runSession: async () => {},
      bindWorkspaceForTask: async () => dir,
      emitTrace: (sid, ev) => traces.push({ sid, ev })
    });
    const run = sched.startRun();
    store.setDaemonControl(`bot.goal-self-heal-owner:${run.id}`, {
      parentSessionId: parent.id,
      objective: goal.objective,
      constraints: [],
      metadata: {
        botId: 'b',
        botGoalId: goal.id,
        botGoalScopeSessionId: parent.id,
        botGoalWorkerRevision: goal.revision,
        botGoalWorkerExecutionId: execution.id,
        botGoalWorker: true
      }
    });
    await sched.processRuns();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].sid, parent.id);
    assert.equal(traces[0].ev.payload.source, 'bot-goal-worker');
    const child = store.getSession(traces[0].ev.payload.childSessionId);
    assert.equal(child.parentSessionId, parent.id);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
