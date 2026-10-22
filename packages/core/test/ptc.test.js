import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PtcIsolateError,
  runPtcCell,
  wrapPtcCellSource
} from '../dist/ptc/isolate.js';
import {
  isPtcSession,
  ptcMetadataPatchFromInput,
  resolvePtcOrchestrationEngine
} from '../dist/ptc/mode.js';
import { buildPtcNamespace } from '../dist/ptc/hooks.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { assertLockedRounds, PtcReplayError, runHardReplay } from '../dist/ptc/replay.js';
import { createPtcAgentHook, parsePtcAgentSpec } from '../dist/ptc/agent-hook.js';
import { createPtcExecTool, PTC_EXEC_TOOL_NAME } from '../dist/ptc/ptc-exec-tool.js';
import { deriveReplayCapability } from '../dist/ptc/orchestration.js';
import { buildReplayPromptBlock } from '../dist/ptc/prompt.js';
import {
  PTC_LAST_RETURN_KEY,
  PTC_SCRATCH_MAX_KEYS,
  PTC_SCRATCH_MAX_VALUE_CHARS,
  PtcScratchpadError,
  PtcScratchpadSession,
  createMemoryScratchPersist,
  createStoreScratchPersist,
  parseScratchpadWrite
} from '../dist/ptc/scratchpad.js';
import { buildPtcOrchestrationBlock } from '../dist/model/prompt-builder.js';
import { SqliteStateStore } from '../dist/storage.js';
import { scratchKeyFilterFromInherit } from '../dist/memory/ptc-meta.js';

test('PTC mode follows dynamic_workflow default and explicit legacy fallback', () => {
  assert.equal(resolvePtcOrchestrationEngine(undefined, 'dynamic_workflow'), 'ptc');
  assert.equal(resolvePtcOrchestrationEngine('legacy', 'dynamic_workflow'), 'legacy');
  assert.equal(resolvePtcOrchestrationEngine('ptc', 'standard'), 'ptc');
  assert.deepEqual(
    ptcMetadataPatchFromInput({
      task_run_mode: 'dynamic_workflow',
      orchestration_engine: 'ptc'
    }),
    { taskRunMode: 'dynamic_workflow', orchestrationEngine: 'ptc' }
  );
  assert.equal(
    isPtcSession({ metadata: { taskRunMode: 'dynamic_workflow' } }),
    true
  );
});

test('PTC isolate supports async composition and final expressions', async () => {
  const calls = [];
  const result = await runPtcCell(
    `
const rows = await Promise.all([agent({ task: 'a' }), agent({ task: 'b' })]);
console.log('workers', rows.length);
rows.map((row) => row.content).join(',')
`,
    {
      hooks: {
        agent: async ({ task }) => {
          calls.push(task);
          return { ok: true, content: task.toUpperCase() };
        }
      }
    }
  );
  assert.deepEqual(calls.sort(), ['a', 'b']);
  assert.equal(result.value, 'A,B');
  assert.deepEqual(result.logs, ['workers 2']);
  assert.match(wrapPtcCellSource('1 + 2'), /return \(1 \+ 2\)/);
});

test('PTC isolate rejects process access and aborts timed-out async work', async () => {
  await assert.rejects(
    () => runPtcCell('return process.env', { hooks: {} }),
    (error) => error instanceof PtcIsolateError && error.code === 'forbidden'
  );

  const controller = new AbortController();
  await assert.rejects(
    () =>
      runPtcCell('await never(); return 1', {
        timeoutMs: 20,
        abortController: controller,
        hooks: { never: () => new Promise(() => {}) }
      }),
    (error) => error instanceof PtcIsolateError && error.code === 'timeout'
  );
  assert.equal(controller.signal.aborted, true);
});

test('PTC isolate does not expose host constructors through injected hooks or errors', async () => {
  for (const code of [
    "return await agent.constructor('return process')()",
    "return await Object.getPrototypeOf(agent).constructor('return process')()",
    "try { process } catch (error) { return error.constructor.constructor('return process')() }"
  ]) {
    await assert.rejects(
      () => runPtcCell(code, { hooks: { agent: async () => ({ ok: true }) } }),
      (error) =>
        error instanceof PtcIsolateError &&
        (error.code === 'forbidden' || error.code === 'runtime')
    );
  }
});

test('PTC namespace only injects explicitly marked read tools', async () => {
  const context = {
    repoRoot: '/tmp',
    stateDir: '/tmp',
    session: { id: 's', metadata: {} },
    agent: { id: 'a' }
  };
  const tool = (name, ptc) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc,
    async execute(_context, args) {
      return { ok: true, content: JSON.stringify(args) };
    }
  });
  const ns = buildPtcNamespace({
    context,
    authorizedTools: [
      tool('read_ok', { kind: 'read' }),
      tool('unmarked'),
      tool('write_no', { kind: 'write' }),
      tool('confirm_no', { kind: 'read', requiresConfirm: true })
    ],
    agent: async () => ({ ok: true }),
    scratchpad: {
      write: async () => ({}),
      read: async () => ({}),
      list: async () => ({}),
      delete: async () => ({})
    },
    verify: async () => ({ ok: true })
  });
  assert.deepEqual(ns.toolNames, ['read_ok']);
  assert.equal(typeof ns.bindings.read_ok, 'function');
  assert.equal(ns.bindings.unmarked, undefined);
  const read = await ns.bindings.read_ok({ hello: 'world' });
  assert.equal(read.ok, true);
});

class PtcScriptedAdapter {
  name = 'ptc-scripted';
  rootSessionId;
  rootToolNames = [];
  rootSystemPrompt = '';

  async runTurn(input) {
    if (input.sessionId !== this.rootSessionId) {
      const user = input.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'text')?.text ?? '';
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: `worker:${user.includes('alpha') ? 'alpha' : 'beta'}` }]
      };
    }

    this.rootToolNames = input.tools.map((tool) => tool.name);
    this.rootSystemPrompt = input.systemPrompt;
    const result = input.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_result' && part.name === 'ptc_exec');
    if (!result) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'ptc-1',
            name: 'ptc_exec',
            input: {
              code: `const workers = await Promise.all([agent({ task: 'alpha', role: 'research' }), agent({ task: 'beta', role: 'review' })]); return workers;`
            }
          }
        ]
      };
    }
    return {
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: result.content }]
    };
  }

  async summarizeMessages() {
    return 'summary';
  }
}

test('dynamic_workflow exposes ptc_exec and composes subagents end-to-end', async () => {
  const adapter = new PtcScriptedAdapter();
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ptc-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ptc-state-')),
    modelAdapter: adapter
  });
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  const { session } = runtime.createTaskSession({
    title: 'PTC task',
    message: 'run dynamically',
    background: false,
    metadata: { taskRunMode: 'dynamic_workflow' }
  });
  adapter.rootSessionId = session.id;

  await runtime.runSession(session.id);

  assert.ok(adapter.rootToolNames.includes('ptc_exec'));
  assert.ok(!adapter.rootToolNames.includes('spawn_subagent'));
  assert.match(adapter.rootSystemPrompt, /Dynamic workflow orchestration \(PTC\)/);
  const output = runtime.getLatestAssistantText(session.id) ?? '';
  assert.match(output, /worker:alpha/);
  assert.match(output, /worker:beta/);
  const updated = runtime.getSession(session.id);
  assert.equal(updated.metadata.ptcLastRunOk, true);
  assert.match(updated.metadata.ptcLastProgram, /Promise\.all/);
});

test('standard sessions deny ptc_exec from the model tool surface', async () => {
  let names = [];
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ptc-standard-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ptc-standard-state-')),
    modelAdapter: {
      name: 'capture',
      async runTurn(input) {
        names = input.tools.map((tool) => tool.name);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      },
      async summarizeMessages() {
        return 'summary';
      }
    }
  });
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  const session = runtime.createChatSession({ title: 'normal', message: 'hello' });
  await runtime.runSession(session.id);
  assert.ok(!names.includes('ptc_exec'));
  assert.ok(names.includes('spawn_subagent'));
});

test('hard v2 rejects out-of-order or mutated dependsOn', () => {
  const locked = [
    {
      workers: [
        { id: 'a', task: 'research {{goal}}', taskTemplate: 'research {{goal}}', dependsOn: [] },
        { id: 'b', task: 'review {{goal}}', taskTemplate: 'review {{goal}}', dependsOn: [] }
      ]
    },
    {
      workers: [
        { id: 'c', task: 'synth', taskTemplate: 'synth {{prev}}', dependsOn: ['a', 'b'] }
      ]
    }
  ];
  assert.throws(
    () =>
      assertLockedRounds(locked, [
        locked[1],
        locked[0]
      ]),
    (error) => error instanceof PtcReplayError && error.code === 'ROUND_ORDER_LOCKED'
  );
  assert.throws(
    () =>
      assertLockedRounds(locked, [
        {
          workers: [
            locked[0].workers[1],
            locked[0].workers[0]
          ]
        },
        locked[1]
      ]),
    (error) => error instanceof PtcReplayError && error.code === 'ROUND_ORDER_LOCKED'
  );
  assert.throws(
    () =>
      assertLockedRounds(locked, [
        locked[0],
        { workers: [{ ...locked[1].workers[0], dependsOn: ['a'] }] }
      ]),
    (error) => error instanceof PtcReplayError && error.code === 'ROUND_ORDER_LOCKED'
  );
  assertLockedRounds(locked, locked);
});

test('hard v3 reruns saved program without historical tool I/O', async () => {
  const calls = [];
  const result = await runHardReplay({
    taskRunMode: 'dynamic_workflow',
    userGoal: 'ship the feature',
    orchestration: {
      name: 'demo',
      schemaVersion: 3,
      slots: [{ name: 'goal', description: 'user goal', source: 'user_goal' }],
      program: `
        const row = await agent({ task: '{{goal}}' });
        return { goal: '{{goal}}', fromAgent: row.content };
      `,
      rounds: []
    },
    spawn: async (spec) => {
      calls.push(spec.task);
      return `fresh:${spec.task}`;
    }
  });
  assert.deepEqual(calls, ['ship the feature']);
  assert.equal(result.programResult.value.goal, 'ship the feature');
  assert.equal(result.programResult.value.fromAgent, 'fresh:ship the feature');
  assert.match(result.synthesisContext, /program result/);
});

test('deriveReplayCapability never upgrades v2 program to hard_ready', () => {
  assert.equal(
    deriveReplayCapability({
      schemaVersion: 3,
      program: 'return 1',
      slots: [{ name: 'goal', description: 'g', source: 'user_goal' }]
    }),
    'hard_ready'
  );
  assert.equal(deriveReplayCapability({ schemaVersion: 3, program: '' }), 'soft_only');
  assert.equal(
    deriveReplayCapability({
      schemaVersion: 2,
      program: 'return 1',
      slots: [{ name: 'goal', description: 'g', source: 'user_goal' }],
      rounds: []
    }),
    'soft_only'
  );
});

test('buildReplayPromptBlock soft vs hard v3', () => {
  const orch = {
    name: 'demo',
    schemaVersion: 3,
    goal: 'ship',
    slots: [{ name: 'goal', description: 'user goal', source: 'user_goal' }],
    rounds: [{ workers: [{ task: 'research', angle: 'fast' }] }]
  };
  const soft = buildReplayPromptBlock(orch, 'soft');
  assert.match(soft, /Prefer this topology/);
  const hard = buildReplayPromptBlock(orch, 'hard');
  assert.match(hard, /saved program is locked/i);
});

test('createPtcAgentHook isolates spawn failures and enforces budget', async () => {
  const hook = createPtcAgentHook({
    maxCalls: 1,
    spawn: async () => {
      throw new Error('spawn boom');
    }
  });
  await assert.rejects(() => hook({}), /non-empty task/);
  const failed = await hook({ task: 'do work' });
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /spawn boom/);
  const budget = await hook({ task: 'again' });
  assert.equal(budget.ok, false);
  assert.match(String(budget.error), /budget exceeded/);
});

test('createPtcExecTool denies non-PTC sessions', async () => {
  const tool = createPtcExecTool({
    getAuthorizedTools: () => [],
    spawnSubagent: async () => 'ok',
    scratchpad: {
      write: async () => {},
      read: async () => null,
      list: async () => [],
      delete: async () => {}
    }
  });
  assert.equal(tool.name, PTC_EXEC_TOOL_NAME);
  const result = await tool.execute(
    {
      repoRoot: '/tmp',
      stateDir: '/tmp',
      session: {
        id: 's1',
        title: 't',
        mode: 'chat',
        status: 'idle',
        agentId: 'general',
        background: false,
        todo: [],
        metadata: {},
        createdAt: '',
        updatedAt: ''
      },
      agent: { id: 'general', name: 'G', role: 'a', instructions: '', capabilities: [] }
    },
    { code: 'return 1' }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /dynamic_workflow/);
});

function ptcContext(id = 'ptc-sess') {
  return {
    repoRoot: '/tmp',
    stateDir: '/tmp',
    session: {
      id,
      title: 't',
      mode: 'task',
      status: 'idle',
      agentId: 'general',
      background: false,
      todo: [],
      metadata: { taskRunMode: 'dynamic_workflow', orchestrationEngine: 'ptc' },
      createdAt: '',
      updatedAt: ''
    },
    agent: { id: 'general', name: 'G', role: 'a', instructions: '', capabilities: [] }
  };
}

function memorySessionStore() {
  const rows = new Map();
  return {
    upsertSessionMemory(input) {
      const entry = {
        id: `${input.sessionId}:${input.scope}:${input.key}`,
        sessionId: input.sessionId,
        scope: input.scope,
        key: input.key,
        value: input.value,
        metadata: input.metadata ?? {},
        source: input.source,
        updatedAt: new Date().toISOString()
      };
      rows.set(entry.id, entry);
      return entry;
    },
    listSessionMemory(sessionId, scope) {
      return [...rows.values()].filter(
        (row) => row.sessionId === sessionId && (!scope || row.scope === scope)
      );
    },
    deleteSessionMemory(sessionId, scope, key) {
      return rows.delete(`${sessionId}:${scope}:${key}`);
    }
  };
}

test('parseScratchpadWrite keeps (key, value) as session visibility', () => {
  const spec = parseScratchpadWrite('notes', 'secret');
  assert.equal(spec.key, 'notes');
  assert.equal(spec.value, 'secret');
  assert.equal(spec.visibility, 'session');
  assert.equal(spec.pin, false);
  const obj = parseScratchpadWrite({
    key: 'plan',
    value: { step: 1 },
    visibility: 'inherit',
    pin: true,
    ttlSec: 30
  });
  assert.equal(obj.key, 'plan');
  assert.equal(obj.visibility, 'inherit');
  assert.equal(obj.pin, true);
  assert.equal(obj.ttlSec, 30);
  assert.equal(obj.value, '{"step":1}');
});

test('cell visibility stays in overlay and is gone after dispose', async () => {
  const store = memorySessionStore();
  const persist = createStoreScratchPersist(store, 's1');
  const pad = new PtcScratchpadSession(persist);
  await pad.write({ key: 'tmp', value: 'only-here', visibility: 'cell' });
  assert.equal((await pad.read('tmp')).content, 'only-here');
  assert.equal(store.listSessionMemory('s1', 'scratch').length, 0);
  pad.dispose();
  const later = new PtcScratchpadSession(persist);
  await assert.rejects(
    () => later.read('tmp'),
    (error) => error instanceof PtcScratchpadError && error.code === 'not_found'
  );
});

test('session write persists and enforces caps, delete, and reserved key', async () => {
  const persist = createMemoryScratchPersist();
  const pad = new PtcScratchpadSession(persist);
  await pad.write('k', 'v');
  assert.equal((await pad.read('k')).content, 'v');
  await assert.rejects(
    () => pad.write('big', 'x'.repeat(PTC_SCRATCH_MAX_VALUE_CHARS + 1)),
    (error) => error instanceof PtcScratchpadError && error.code === 'too_large'
  );
  for (let i = 0; i < PTC_SCRATCH_MAX_KEYS - 1; i += 1) {
    await pad.write(`k${i}`, 'v');
  }
  await assert.rejects(
    () => pad.write('overflow', 'no'),
    (error) => error instanceof PtcScratchpadError && error.code === 'quota'
  );
  await assert.rejects(
    () => pad.write(PTC_LAST_RETURN_KEY, 'nope'),
    (error) => error instanceof PtcScratchpadError && error.code === 'reserved'
  );
  await pad.delete('k');
  await assert.rejects(
    () => pad.read('k'),
    (error) => error instanceof PtcScratchpadError && error.code === 'not_found'
  );
});

test('store persist writes session keys and expires ttlSec 0', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ptc-scratch-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const persist = createStoreScratchPersist(store, 's1');
  const pad = new PtcScratchpadSession(persist);
  await pad.write('k', 'v');
  await pad.write({ key: 'tmp', value: 'c', visibility: 'cell' });
  const rows = store.listSessionMemory('s1', 'scratch');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ptc.k');
  assert.equal(rows[0].value, 'v');
  assert.equal(rows[0].source, 'ptc');
  await pad.write({ key: 'ephemeral', value: 'gone', ttlSec: 0 });
  await assert.rejects(
    () => pad.read('ephemeral'),
    (error) => error instanceof PtcScratchpadError && error.code === 'not_found'
  );
  assert.equal(
    store.listSessionMemory('s1', 'scratch').some((row) => row.key === 'ptc.ephemeral'),
    false
  );
  store.db.close();
});

test('ptc_exec spills oversized return to __last_return', async () => {
  const store = memorySessionStore();
  const tool = createPtcExecTool({
    getAuthorizedTools: () => [],
    spawnSubagent: async () => 'ok',
    createScratchPersist: () => createStoreScratchPersist(store, 'spill')
  });
  const small = await tool.execute(ptcContext('spill'), { code: 'return "ok"' });
  assert.equal(small.ok, true);
  assert.match(small.content, /"ok"/);
  assert.equal(small.metadata?.ptc?.ref, undefined);

  const large = await tool.execute(ptcContext('spill'), {
    code: `return ${JSON.stringify('z'.repeat(20_000))}`
  });
  assert.equal(large.ok, true);
  assert.match(large.content, /__last_return/);
  assert.equal(large.metadata?.ptc?.ref, PTC_LAST_RETURN_KEY);
  assert.ok(large.content.length < 20_000);
  const stored = store.listSessionMemory('spill', 'scratch').find((row) => row.key === 'ptc.__last_return');
  assert.ok(stored);
  assert.ok(stored.value.includes('z'.repeat(20_000)));
});

test('hard v3 replay uses real scratch persist', async () => {
  const persist = createMemoryScratchPersist();
  const written = await runHardReplay({
    taskRunMode: 'dynamic_workflow',
    userGoal: 'goal',
    scratchPersist: persist,
    orchestration: {
      name: 'scratch',
      schemaVersion: 3,
      slots: [{ name: 'goal', description: 'g', source: 'user_goal' }],
      program: "await scratchpad.write('k', 'v'); return await scratchpad.read('k');",
      rounds: []
    }
  });
  assert.equal(written.programResult.value.content, 'v');
  const later = await runHardReplay({
    taskRunMode: 'dynamic_workflow',
    userGoal: 'goal',
    scratchPersist: persist,
    orchestration: {
      name: 'scratch-read',
      schemaVersion: 3,
      slots: [{ name: 'goal', description: 'g', source: 'user_goal' }],
      program: "return await scratchpad.read('k');",
      rounds: []
    }
  });
  assert.equal(later.programResult.value.content, 'v');
  const fallback = await runHardReplay({
    taskRunMode: 'dynamic_workflow',
    userGoal: 'goal',
    orchestration: {
      name: 'mem',
      schemaVersion: 3,
      slots: [{ name: 'goal', description: 'g', source: 'user_goal' }],
      program: "await scratchpad.write('mem', 'ok'); return await scratchpad.read('mem');",
      rounds: []
    }
  });
  assert.equal(fallback.programResult.value.content, 'ok');
});

test('parsePtcAgentSpec reads inherit_scratch and summary_max_chars', () => {
  const spec = parsePtcAgentSpec({
    task: 'do it',
    inherit_scratch: ['plan', 'ptc.notes'],
    summary_max_chars: 20
  });
  assert.deepEqual(spec.inheritScratch, ['plan', 'ptc.notes']);
  assert.equal(spec.summaryMaxChars, 20);
  assert.equal(parsePtcAgentSpec({ task: 'x', inheritScratch: true }).inheritScratch, true);
  assert.equal(scratchKeyFilterFromInherit(undefined)('ptc.plan'), false);
  assert.equal(scratchKeyFilterFromInherit(undefined)('ctx'), true);
  assert.equal(scratchKeyFilterFromInherit(true)('ptc.plan'), true);
  assert.equal(scratchKeyFilterFromInherit(['plan'])('ptc.plan'), true);
  assert.equal(scratchKeyFilterFromInherit(['ptc.plan'])('ptc.plan'), true);
  assert.equal(scratchKeyFilterFromInherit(['plan'])('ptc.extra'), false);
});

test('PTC prompt names visibility, inherit_scratch, and delete', () => {
  const block = buildPtcOrchestrationBlock();
  assert.match(block, /visibility/);
  assert.match(block, /inherit_scratch/);
  assert.match(block, /delete/);
  assert.match(block, /__last_return/);
});

test('agent() copies ptc.* only when inherit_scratch allows it', async () => {
  const adapter = new PtcScriptedAdapter();
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ptc-inherit-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ptc-inherit-state-')),
    modelAdapter: adapter
  });
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  const { session } = runtime.createTaskSession({
    title: 'PTC inherit',
    message: 'run inherit',
    background: false,
    metadata: { taskRunMode: 'dynamic_workflow' }
  });
  adapter.rootSessionId = session.id;
  runtime.store.upsertSessionMemory({
    sessionId: session.id,
    scope: 'scratch',
    key: 'ctx',
    value: 'shared'
  });
  adapter.runTurn = async (input) => {
    if (input.sessionId !== adapter.rootSessionId) {
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: `worker:${input.agent.id}` }]
      };
    }
    adapter.rootToolNames = input.tools.map((tool) => tool.name);
    const result = input.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_result' && part.name === 'ptc_exec');
    if (!result) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'ptc-inherit',
            name: 'ptc_exec',
            input: {
              code: `
await scratchpad.write('plan', 'v1');
await scratchpad.write('extra', 'no');
await agent({ task: 'default child', role: 'research' });
await agent({ task: 'allow plan', role: 'review', inherit_scratch: ['plan'] });
await agent({ task: 'allow all', role: 'planner', inherit_scratch: true });
return 'done';
`
            }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: result.content }] };
  };

  await runtime.runSession(session.id);
  const children = runtime.listSessions().filter((row) => row.parentSessionId === session.id);
  const researcher = children.find((row) => row.agentId === 'researcher');
  const reviewer = children.find((row) => row.agentId === 'reviewer');
  const planner = children.find((row) => row.agentId === 'planner');
  assert.ok(researcher && reviewer && planner);
  const researchMem = runtime.store.listSessionMemory(researcher.id, 'scratch');
  const reviewMem = runtime.store.listSessionMemory(reviewer.id, 'scratch');
  const plannerMem = runtime.store.listSessionMemory(planner.id, 'scratch');
  assert.equal(researchMem.find((row) => row.key === 'ctx')?.value, 'shared');
  assert.equal(researchMem.some((row) => row.key === 'ptc.plan'), false);
  assert.equal(reviewMem.find((row) => row.key === 'ptc.plan')?.value, 'v1');
  assert.equal(reviewMem.some((row) => row.key === 'ptc.extra'), false);
  assert.equal(plannerMem.find((row) => row.key === 'ptc.plan')?.value, 'v1');
  assert.equal(plannerMem.find((row) => row.key === 'ptc.extra')?.value, 'no');
});
