import { describe, expect, it } from 'vitest';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import type { AgentSpec, ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';
import type { TurnKernelHost, TurnKernelStore } from './host.js';
import { runSessionKernel } from './kernel.js';
import { noteTrajectoryWrite } from '../trajectory-handoff/tool-entry.js';


function metaField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(key in value)) return undefined;
  const record = value as Record<string, unknown>;
  return record[key];
}
function textResult(text: string): ModelTurnResult {
  return { stopReason: 'end', assistantParts: [{ type: 'text', text }] };
}

function toolResult(): ModelTurnResult {
  return {
    stopReason: 'tool_use',
    assistantParts: [{ type: 'tool_call', toolCallId: 'c1', name: 'echo', input: {} }],
  };
}

function harness(metadata?: Record<string, unknown>) {
  const surface = createMemorySurfaceStore();
  const spec: AgentSpec = { id: 'agent-1', name: 'Test', role: 'assistant', instructions: 'test', capabilities: [] };
  const session = surface.createSession({ title: 't', mode: 'chat', agentId: spec.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
  if (metadata) surface.updateSession(session.id, { metadata });
  const calls = { execute: 0 };
  let turn = 0;
  const model: ModelAdapter = {
    name: 'stub',
    async runTurn() {
      turn += 1;
      return turn === 1 ? toolResult() : textResult('done');
    },
    async summarizeMessages() {
      return '';
    },
  };
  const echo: ToolContract = {
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: 'ok' }),
  };
  const store: TurnKernelStore = {
    getSession: (id) => surface.getSession(id),
    updateSession: (id, patch) => surface.updateSession(id, patch),
    foldMessages: (id) => surface.foldMessages(id),
    appendMessage: (id, role, parts, opts) => surface.appendMessage(id, role, parts, opts),
    appendReplacement: (id, input) => surface.appendReplacement(id, input),
    getAgent: (id) => (id === spec.id ? spec : undefined),
    claimWriter: (id, runId) => surface.claimWriter(id, runId),
    releaseWriter: (id, runId) => surface.releaseWriter(id, runId),
    listApprovals: () => [],
    claimInbox: (id, target) => surface.claimInbox(id, target),
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, opts) => surface.hideRange(id, start, end, opts),
    getDaemonControl: () => undefined,
  };
  const host: TurnKernelHost = {
    store,
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/state',
    modelAdapter: model,
    promptBuilder: { buildSystemPrompt: async () => 'sys', buildMemoryAppendix: () => '' },
    tools: [echo],
    maxTurnsPerRun: 4,
    emitTrace: () => undefined,
    mergeSessionMetadata: (id, patch) => {
      const cur = store.getSession(id)!;
      return store.updateSession(id, { metadata: { ...cur.metadata, ...patch } });
    },
    runTurnWithRetries: (input) => host.modelAdapter.runTurn(input),
    executeToolCalls: async (toolCalls) => {
      calls.execute += 1;
      return toolCalls.map((item) => ({ toolCallId: item.toolCallId, name: item.name, ok: true, content: 'ok' }));
    },
    prepareMessagesForModel: async (_s, messages) => messages,
    autoCompact: async () => ({}),
    handleTurnCompletion: async (s) => store.updateSession(s.id, { status: 'idle' }),
    processToolResults: (results, _calls, _session, _task, sessionId) => {
      store.appendMessage(sessionId, 'tool', results.map((result) => ({
        type: 'tool_result' as const,
        toolCallId: result.toolCallId,
        name: result.name,
        ok: result.ok,
        content: result.content,
      })));
    },
  };
  return { host, store, session, calls };
}


describe('kernel trajectory handoff gate', () => {
  it('does not execute a tool wave while a write is still in flight [AC:trajectory-handoff-explicit#TH-5]', async () => {
    const { host, store, session, calls } = harness({
      capabilityTiers: { enabled: true },
      handoffState: 'planner_readonly',
    });
    noteTrajectoryWrite(session.id, 'inflight-1');
    await runSessionKernel(host, session.id);
    expect(calls.execute).toBe(0);
    const transcript = JSON.stringify(store.foldMessages(session.id));
    expect(transcript).toContain('Failing closed');
  });

  it('still executes tools when handoff metadata is missing', async () => {
    const { host, session, calls } = harness();
    await runSessionKernel(host, session.id);
    expect(calls.execute).toBeGreaterThanOrEqual(1);
  });

  it('switches planner to executor on the same session and keeps one context pack', async () => {
    const seen: string[] = [];
    const { host, store, session } = harness({
      capabilityTiers: {
        enabled: true,
        roles: { plannerModel: 'planner/model', executorModel: 'executor/model' },
      },
    });
    host.tools = [...host.tools, {
      name: 'submit_plan',
      description: 'submit',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'plan' }),
    }];
    host.runTurnWithRetries = async (input) => {
      const live = store.getSession(input.sessionId!)!;
      seen.push(String(live.metadata?.handoffRole ?? 'missing'));
      return host.modelAdapter.runTurn(input);
    };
    host.modelAdapter.runTurn = async () => {
      if (seen.length === 1) {
        return {
          stopReason: 'tool_use',
          assistantParts: [{ type: 'tool_call', toolCallId: 'plan-1', name: 'submit_plan', input: {} }],
        };
      }
      return textResult('done');
    };
    host.executeToolCalls = async (toolCalls) => toolCalls.map((item) => ({
      toolCallId: item.toolCallId,
      name: item.name,
      ok: true,
      content: 'plan accepted',
      metadata: { planVersion: 2, handoffPlanAccepted: true },
    }));
    await runSessionKernel(host, session.id);
    expect(seen).toEqual(['planner', 'executor']);
    const after = store.getSession(session.id)!;
    expect(after.id).toBe(session.id);
    expect(metaField(metaField(after.metadata?.handoffKernel, 'counters'), 'sessionHandoffs')).toBe(1);
    const pack = after.metadata?.handoffContext;
    expect(metaField(pack, 'planVersion')).toBe(2);
    expect(metaField(pack, 'fromModel')).toBe('planner/model');
    expect(metaField(pack, 'toModel')).toBe('executor/model');
    expect(Array.isArray(metaField(pack, 'toolPairs'))).toBe(true);
    expect(metaField(pack, 'completedEffects')).toEqual([]);
  });

  it('keeps the same pack shape when both roles name one model', async () => {
    const { host, store, session } = harness({
      capabilityTiers: { enabled: true, roles: { plannerModel: 'same/model', executorModel: 'same/model' } },
    });
    host.tools = [...host.tools, {
      name: 'submit_plan',
      description: 'submit',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'plan' }),
    }];
    host.runTurnWithRetries = (input) => host.modelAdapter.runTurn(input);
    host.modelAdapter.runTurn = async () => ({
      stopReason: 'tool_use',
      assistantParts: [{ type: 'tool_call', toolCallId: 'plan-1', name: 'submit_plan', input: {} }],
    });
    let turns = 0;
    const original = host.modelAdapter.runTurn.bind(host.modelAdapter);
    host.modelAdapter.runTurn = async (input) => {
      turns += 1;
      if (turns > 1) return textResult('done');
      return original(input);
    };
    host.executeToolCalls = async (toolCalls) => toolCalls.map((item) => ({
      toolCallId: item.toolCallId,
      name: item.name,
      ok: true,
      content: 'ok',
      metadata: { planVersion: 1, handoffPlanAccepted: true },
    }));
    await runSessionKernel(host, session.id);
    const pack = store.getSession(session.id)?.metadata?.handoffContext;
    expect(metaField(pack, 'fromModel')).toBe('same/model');
    expect(metaField(pack, 'toModel')).toBe('same/model');
    expect(metaField(pack, 'planVersion')).toBe(1);
    expect(Array.isArray(metaField(pack, 'toolPairs'))).toBe(true);
    expect(Array.isArray(metaField(pack, 'completedEffects'))).toBe(true);
  });

  it('planner denies write, command, and delegate calls inside the kernel wave', async () => {
    const received: string[][] = [];
    const { host, session } = harness({
      capabilityTiers: { enabled: true },
      handoffState: 'planner_readonly',
      originalPerms: ['read', 'write', 'command', 'delegate'],
    });
    const tool = (name: string, access: 'read' | 'edit' | 'bash' | 'delegate'): ToolContract => ({
      name,
      description: name,
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: access === 'read' ? 'none' : 'workspace',
      access,
      execute: async () => ({ ok: true, content: name }),
    });
    host.tools = [
      tool('read_file', 'read'),
      tool('write_file', 'edit'),
      tool('bash', 'bash'),
      tool('spawn_subagent', 'delegate'),
    ];
    host.modelAdapter.runTurn = async () => ({
      stopReason: 'tool_use',
      assistantParts: host.tools.map((item, index) => ({
        type: 'tool_call' as const,
        toolCallId: `c${index}`,
        name: item.name,
        input: {},
      })),
    });
    let waves = 0;
    const scripted = host.modelAdapter.runTurn.bind(host.modelAdapter);
    host.modelAdapter.runTurn = async (input) => {
      waves += 1;
      if (waves > 1) return textResult('done');
      return scripted(input);
    };
    host.executeToolCalls = async (toolCalls) => {
      received.push(toolCalls.map((item) => item.name));
      return toolCalls.map((item) => ({ toolCallId: item.toolCallId, name: item.name, ok: true, content: 'ok' }));
    };
    await runSessionKernel(host, session.id);
    expect(received[0]).toEqual(['read_file']);
  });
});
