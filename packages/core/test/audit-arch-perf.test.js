import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { assistantTextsFromFold } from '../dist/session/visible-assistant.js';
import { closeOpenToolWave, TOOL_WAVE_INTERRUPTED_CONTENT } from '../dist/session/tool-wave-close.js';
import { processToolResults } from '../dist/runtime/tool-loop.js';
import { runScheduler } from '../dist/runtime/scheduler-host.js';
import { applyOptionalFoldBudget } from '../dist/turn/prepare-view.js';

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-arch-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

test('folded assistant text omits a hidden row that listMessages still has', () => {
  const store = openStore();
  try {
    const session = store.createSession({ title: 'fold', mode: 'chat', agentId: 'general' });
    store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'keep me' }]);
    const hidden = store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'SECRET_OLD' }]);
    store.hideRange(session.id, hidden.seq, hidden.seq);
    const folded = assistantTextsFromFold(store, session.id).join('\n');
    assert.match(folded, /keep me/);
    assert.equal(folded.includes('SECRET_OLD'), false);
    assert.ok(store.listMessages(session.id).some((message) => message.parts.some((part) => part.type === 'text' && part.text === 'SECRET_OLD')));
    assert.equal(assistantTextsFromFold(store, session.id, hidden.id).includes('SECRET_OLD'), false);
  } finally {
    store.db.close();
  }
});

test('processToolResults does not duplicate a tool call closed by cancel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-wave-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const session = store.createSession({ title: 'wave', mode: 'chat', agentId: 'general' });
    store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'c1', name: 'echo', input: {} }
    ]);
    closeOpenToolWave(store, session.id, 'interrupted');
    processToolResults(
      {
        tools: [],
        store,
        envApprovalPolicy: undefined,
        maxParallelToolCalls: 1,
        modelAdapter: {
          name: 'stub',
          async runTurn() {
            return { stopReason: 'end', assistantParts: [] };
          },
          async summarizeMessages() {
            return '';
          }
        },
        stateDir: dir,
        emitTrace() {}
      },
      [{ toolCallId: 'c1', name: 'echo', ok: true, content: 'late' }],
      [],
      session,
      undefined,
      session.id
    );
    const results = store
      .foldMessages(session.id)
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, TOOL_WAVE_INTERRUPTED_CONTENT);
  } finally {
    store.db.close();
  }
});

test('idle background lookup skips foreground sessions and empty mode lists', () => {
  const store = openStore();
  try {
    const idle = store.createSession({ title: 'bg', mode: 'task', agentId: 'general', background: true });
    store.createSession({ title: 'fg', mode: 'task', agentId: 'general', background: false });
    store.createSession({ title: 'chat', mode: 'chat', agentId: 'general', background: true });
    const found = store.listIdleBackgroundSessions(['task', 'teammate']);
    assert.deepEqual(found.map((session) => session.id), [idle.id]);
    assert.deepEqual(store.listIdleBackgroundSessions([]), []);
    store.appendMessage(idle.id, 'assistant', [{ type: 'text', text: 'done' }]);
    assert.equal(store.hasAssistantOrToolMessage(idle.id), true);
    assert.equal(store.hasAssistantOrToolMessage('missing'), false);
  } finally {
    store.db.close();
  }
});

test('a failing scheduler step does not skip the later steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-sched-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const seen = [];
  const host = {
    store,
    stateDir: dir,
    log: { warn() {} },
    cronStore: undefined,
    setCronStore() {},
    selfHeal: {
      async processRuns() {
        throw new Error('npm hung');
      }
    },
    swarmExecutor: {
      async tick() {
        throw new Error('swarm down');
      }
    },
    orchestrationEngine: {
      async tick() {
        seen.push('orchestration');
      }
    },
    autonomousScheduler: {
      async tick() {
        seen.push('autonomous');
      }
    },
    async runSession() {}
  };
  await runScheduler(host);
  assert.deepEqual(seen, ['orchestration', 'autonomous']);
  store.db.close();
});

test('later scheduler steps start before self-heal finishes, and the tick waits for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-sched-join-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  let releaseHeal = () => {};
  const heal = new Promise((resolve) => {
    releaseHeal = resolve;
  });
  const order = [];
  const host = {
    store,
    stateDir: dir,
    log: { warn() {} },
    cronStore: { dueJobs: () => [] },
    setCronStore() {},
    selfHeal: {
      processRuns() {
        order.push('heal-start');
        return heal;
      }
    },
    swarmExecutor: {
      async tick() {
        order.push('swarm');
      }
    },
    orchestrationEngine: {
      async tick() {
        order.push('orchestration');
      }
    },
    autonomousScheduler: {
      async tick() {
        order.push('autonomous');
      }
    },
    async runSession() {}
  };
  try {
    let settled = false;
    const task = runScheduler(host).finally(() => {
      settled = true;
    });
    const deadline = Date.now() + 2000;
    while (!order.includes('autonomous') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(order, ['heal-start', 'swarm', 'orchestration', 'autonomous']);
    assert.equal(settled, false);
    releaseHeal();
    await task;
    assert.equal(settled, true);
  } finally {
    store.db.close();
  }
});

test('fold budget stubs an old tool result before episodic selection', () => {
  const previousBudget = process.env.RAW_AGENT_EPISODIC_TOKEN_BUDGET;
  const previousCognitive = process.env.RAW_AGENT_COGNITIVE_STATE_SELECTION;
  process.env.RAW_AGENT_EPISODIC_TOKEN_BUDGET = '800';
  process.env.RAW_AGENT_COGNITIVE_STATE_SELECTION = '0';
  try {
    const huge = `HUGE_PAYLOAD ${'x'.repeat(20_000)}`;
    const messages = [
      { id: 'u-early', role: 'user', seq: 1, createdAt: '2020-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'KEEP_EARLY' }] },
      {
        id: 't-old',
        role: 'tool',
        seq: 2,
        createdAt: '2020-01-01T00:00:01.000Z',
        parts: [{ type: 'tool_result', toolCallId: 'old', name: 'bash', ok: true, content: huge }]
      },
      { id: 'u-recent', role: 'user', seq: 3, createdAt: '2020-01-01T00:20:00.000Z', parts: [{ type: 'text', text: 'recent' }] }
    ];
    for (let i = 0; i < 3; i += 1) {
      messages.push({
        id: `t-new-${i}`,
        role: 'tool',
        seq: 4 + i,
        createdAt: '2020-01-01T00:20:01.000Z',
        parts: [{ type: 'tool_result', toolCallId: `new-${i}`, name: 'bash', ok: true, content: 'short' }]
      });
    }
    for (let i = 0; i < 22; i += 1) {
      messages.push({
        id: `a-${i}`,
        role: 'assistant',
        seq: 10 + i,
        createdAt: '2020-01-01T00:21:00.000Z',
        parts: [{ type: 'text', text: 'ok' }]
      });
    }
    const session = { id: 's1', metadata: {} };
    const host = {
      store: { getDaemonControl() { return undefined; } },
      emitTrace() {},
      turnShapeBySession: new Map(),
      promptBuilder: { lastCognitivePhaseBySession: new Map() }
    };
    const selected = applyOptionalFoldBudget(host, session, messages);
    const old = selected.find((message) => message.id === 't-old');
    assert.ok(old, 'stubbed early tool result stays in the budget');
    const content = old.parts[0].content;
    assert.equal(content.includes('HUGE_PAYLOAD'), false);
    assert.match(content, /omitted to save space/);
    assert.ok(selected.some((message) => message.id === 'u-early'));
  } finally {
    if (previousBudget === undefined) delete process.env.RAW_AGENT_EPISODIC_TOKEN_BUDGET;
    else process.env.RAW_AGENT_EPISODIC_TOKEN_BUDGET = previousBudget;
    if (previousCognitive === undefined) delete process.env.RAW_AGENT_COGNITIVE_STATE_SELECTION;
    else process.env.RAW_AGENT_COGNITIVE_STATE_SELECTION = previousCognitive;
  }
});
