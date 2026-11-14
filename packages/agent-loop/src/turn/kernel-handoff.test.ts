import { describe, expect, it } from 'vitest';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import type { AgentSpec, ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';
import type { TurnKernelHost, TurnKernelStore } from './host.js';
import { runSessionKernel } from './kernel.js';
import { noteTrajectoryWrite } from '../trajectory-handoff/tool-entry.js';

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
});
