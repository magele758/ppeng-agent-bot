import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec, ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import type { TurnKernelHost, TurnKernelStore } from './host.js';
import { runSessionKernel } from './kernel.js';

const PLANTED = 'PLANTED_MESSAGE_DO_NOT_LEAK';

const SHARED_PHASES = [
  'writer_claim',
  'ensure_mcp',
  'resolve_file_policy',
  'ingest_mailbox',
  'auto_claim_task',
  'claim_next_run',
  'ensure_workspace',
  'resolve_workspace',
  'pack_turn',
  'build_system_prompt',
  'before_turn_hook',
  'pick_turn_tools',
  'before_model',
] as const;

function agent(): AgentSpec {
  return { id: 'agent-1', name: 'Test', role: 'assistant', instructions: 'test', capabilities: [] };
}

function stubAdapter(impl: () => ModelTurnResult): ModelAdapter {
  return {
    name: 'stub',
    async runTurn() {
      return impl();
    },
    async summarizeMessages() {
      return '';
    },
  };
}

function createHarness(opts?: {
  emitTrace?: TurnKernelHost['emitTrace'];
  buildSystemPrompt?: () => Promise<string>;
}) {
  const surface = createMemorySurfaceStore();
  const spec = agent();
  const session = surface.createSession({ title: 't', mode: 'chat', agentId: spec.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: PLANTED }]);
  const store: TurnKernelStore = {
    getSession: (id) => surface.getSession(id),
    updateSession: (id, patch) => surface.updateSession(id, patch),
    foldMessages: (id) => surface.foldMessages(id),
    appendMessage: (id, role, parts, appendOpts) => surface.appendMessage(id, role, parts, appendOpts),
    appendReplacement: (id, input) => surface.appendReplacement(id, input),
    getAgent: (id) => (id === spec.id ? spec : undefined),
    claimWriter: (id, runId) => surface.claimWriter(id, runId),
    releaseWriter: (id, runId) => surface.releaseWriter(id, runId),
    listApprovals: () => [],
    claimInbox: (id, target) => surface.claimInbox(id, target),
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, rangeOpts) => surface.hideRange(id, start, end, rangeOpts),
    getDaemonControl: () => undefined,
  };
  const echo: ToolContract = {
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: 'ok' }),
  };
  const traces: Array<{ kind: string; data?: Record<string, unknown>; payload?: Record<string, unknown> }> = [];
  const host: TurnKernelHost = {
    store,
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/state',
    modelAdapter: stubAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] })),
    promptBuilder: {
      buildSystemPrompt: opts?.buildSystemPrompt ?? (async () => 'sys'),
      buildMemoryAppendix: () => '',
    },
    tools: [echo],
    maxTurnsPerRun: 2,
    emitTrace: opts?.emitTrace ?? ((_id, event) => {
      traces.push({ kind: event.kind, data: event.data, payload: event.payload });
    }),
    mergeSessionMetadata: (id, patch) => {
      const cur = store.getSession(id)!;
      return store.updateSession(id, { metadata: { ...cur.metadata, ...patch } });
    },
    runTurnWithRetries: (input) => host.modelAdapter.runTurn(input),
    executeToolCalls: async (toolCalls) => toolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      name: c.name,
      ok: true,
      content: 'ok',
    })),
    prepareMessagesForModel: async (_s, messages) => messages,
    autoCompact: async () => ({}),
    handleTurnCompletion: async (s) => store.updateSession(s.id, { status: 'idle' }),
    processToolResults: (results, _calls, _session, _task, sessionId) => {
      store.appendMessage(sessionId, 'tool', results.map((r) => ({
        type: 'tool_result' as const,
        toolCallId: r.toolCallId,
        name: r.name,
        ok: r.ok,
        content: r.content,
      })));
    },
  };
  return { host, session, traces };
}

describe('kernel startup phases', () => {
  it('[AC:bot-startup-trace#AC-1] [AC:bot-startup-trace#AC-2] [AC:bot-startup-trace#AC-5] [AC:bot-startup-trace#AC-6] delayed buildSystemPrompt is the slowest phase and skipped optionals still record a duration', async () => {
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    const { host, session, traces } = createHarness({
      buildSystemPrompt: async () => {
        clock += 40;
        return 'sys';
      },
    });
    const out = await runSessionKernel(host, session.id);
    now.mockRestore();
    expect(out.status).toBe('idle');
    const events = traces.filter((event) => event.kind === 'startup_phase');
    expect(JSON.stringify(events)).not.toContain(PLANTED);
    const byPhase = new Map(events.map((event) => [event.payload?.phase, event]));
    for (const phase of SHARED_PHASES) {
      const event = byPhase.get(phase);
      expect(event?.data).toEqual(event?.payload);
      expect(event?.payload?.scope).toBe('kernel');
      expect(typeof event?.payload?.durationMs).toBe('number');
    }
    const prompt = byPhase.get('build_system_prompt');
    expect(prompt?.payload?.durationMs).toBe(40);
    const ready = events.filter((event) => event.payload?.phase === 'ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]?.payload?.turn).toBe(0);
    expect(ready[0]?.payload?.scope).toBe('kernel');
    expect(ready[0]?.payload?.slowest).toBe('build_system_prompt');
    expect(ready[0]?.payload?.slowestMs).toBe(40);
    const phases = ready[0]?.payload?.phases as Record<string, number>;
    expect(phases.ready).toBeUndefined();
    expect(phases.writer_claim).toEqual(expect.any(Number));
    expect(phases.build_system_prompt).toBe(40);
    expect(phases.ensure_mcp).toBe(0);
    expect(phases.before_model).toBe(0);
  });

  it('[AC:bot-startup-trace#AC-6] throwing emitTrace still finishes the session', async () => {
    const { host, session } = createHarness({
      emitTrace: () => {
        throw new Error('trace down');
      },
    });
    const out = await runSessionKernel(host, session.id);
    expect(out.status).toBe('idle');
  });
});
