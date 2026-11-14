import { describe, expect, it, vi } from 'vitest';
import { createMemorySurfaceStore, type MemorySurfaceStore } from '../session/surface-store.js';
import type { RunContext, ToolContract } from '../types.js';
import { executeSingleTool, type ToolLoopHost } from '../runtime/tool-loop.js';
import { trajectoryHandoffGateFromMetadata } from '../runtime/run-profile.js';
import type { TurnKernelHost } from '../turn/host.js';
import { handoffRuntimeEnabled } from './host-integration.js';
import { enterAutoPlannerReadonly, prepareExplicitSessionHandoff } from './session-turn.js';
import { denyTrajectoryTool, executeAutoEligibleToolWave } from './tool-entry.js';

function autoMetadata(): Record<string, unknown> {
  return {
    handoffEnablement: { source: 'auto_policy' },
    capabilityTiers: { enablementSource: 'auto_policy', enabled: false },
  };
}

function toolHost(): ToolLoopHost {
  return {
    env: {},
    appendMessage: () => undefined,
    listApprovals: () => [],
    createApproval: (input) => ({ id: 'ap', status: 'pending', createdAt: '', ...input }) as never,
    deleteApproval: () => undefined,
    getTask: () => undefined,
    updateTask: () => undefined,
    emitTrace: () => undefined,
  };
}

function tool(
  name: string,
  execute: ToolContract<Record<string, unknown>>['execute'],
  extra: Partial<ToolContract<Record<string, unknown>>> = {},
): ToolContract<Record<string, unknown>> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute,
    ...extra,
  };
}

interface KnifeHostedSession {
  surface: MemorySurfaceStore;
  sessionId: string;
  host: Pick<TurnKernelHost, 'store' | 'mergeSessionMetadata'>;
}

function enablementSourceOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('enablementSource' in value)) return undefined;
  const source = value.enablementSource;
  return typeof source === 'string' ? source : undefined;
}

function sessionHost(mode: 'chat' | 'task', metadata: Record<string, unknown>): KnifeHostedSession {
  const surface = createMemorySurfaceStore();
  const created = surface.createSession({ title: 'knife2', mode, agentId: 'agent-1' });
  surface.appendMessage(created.id, 'user', [{ type: 'text', text: 'hi' }]);
  surface.updateSession(created.id, { metadata });
  const store = {
    getSession: (id: string) => surface.getSession(id),
    updateSession: (id: string, patch: { metadata?: Record<string, unknown>; status?: 'idle' }) =>
      surface.updateSession(id, patch),
  };
  const host = {
    store: store as TurnKernelHost['store'],
    mergeSessionMetadata: (id: string, patch: Record<string, unknown>) => {
      const current = store.getSession(id);
      return store.updateSession(id, { metadata: { ...(current?.metadata ?? {}), ...patch } });
    },
  };
  return { surface, sessionId: created.id, host };
}

async function runTool(
  metadata: Record<string, unknown>,
  spec: ToolContract<Record<string, unknown>>,
) {
  const session = { id: `s-${spec.name}`, metadata };
  const denied = denyTrajectoryTool(session, spec);
  const result = await executeSingleTool(
    toolHost(),
    [spec],
    { type: 'tool_call', toolCallId: `tc-${spec.name}`, name: spec.name, input: {} },
    { session } as RunContext,
    false,
    session.id,
  );
  return { session, denied, result };
}

async function autoWave(
  hosted: KnifeHostedSession,
  spec: { name: string; access?: string; sideEffectLevel?: string },
) {
  const executed: string[] = [];
  const session = hosted.surface.getSession(hosted.sessionId);
  if (!session) throw new Error('missing session');
  const results = await executeAutoEligibleToolWave({
    session,
    calls: [{ toolCallId: `tc-${spec.name}`, name: spec.name, input: {} }],
    tools: [spec],
    execute: async (calls) => {
      executed.push(...calls.map((call) => call.name));
      return calls.map((call) => ({
        toolCallId: call.toolCallId,
        name: call.name,
        ok: true,
        content: 'ran',
      }));
    },
    enterPlanner: () => enterAutoPlannerReadonly(hosted.host, hosted.sessionId),
  });
  return {
    executed,
    results,
    metadata: hosted.surface.getSession(hosted.sessionId)?.metadata,
  };
}

describe('knife2 handoff paths', () => {
  it('allows an auto_eligible read and refuses write_file and bash without executing them', async () => {
    const read = sessionHost('chat', autoMetadata());
    const readMetadata = read.surface.getSession(read.sessionId)?.metadata;
    expect(trajectoryHandoffGateFromMetadata(readMetadata).path).toBe('auto_eligible');
    expect(handoffRuntimeEnabled(readMetadata)).toBe(false);
    const readWave = await autoWave(read, { name: 'read_file', access: 'read', sideEffectLevel: 'none' });
    expect(readWave.executed).toEqual(['read_file']);
    expect(readWave.results[0]?.ok).toBe(true);
    expect(readWave.metadata?.handoffState).toBeUndefined();

    const write = sessionHost('chat', autoMetadata());
    const writeWave = await autoWave(write, { name: 'write_file', access: 'edit', sideEffectLevel: 'workspace' });
    expect(writeWave.executed).not.toContain('write_file');
    expect(writeWave.results[0]?.ok).toBe(false);
    expect(writeWave.metadata?.handoffState).toBe('planner_readonly');
    expect(trajectoryHandoffGateFromMetadata(writeWave.metadata).path).toBe('in_machine');

    const bash = sessionHost('chat', autoMetadata());
    const bashWave = await autoWave(bash, { name: 'bash', access: 'bash', sideEffectLevel: 'system' });
    expect(bashWave.executed).not.toContain('bash');
    expect(bashWave.results[0]?.ok).toBe(false);
    expect(bashWave.metadata?.handoffState).toBe('planner_readonly');

    for (const name of ['bash', 'shell', 'browser', 'http', 'mcp']) {
      const hosted = sessionHost('chat', autoMetadata());
      const mistagged = await autoWave(hosted, { name, access: 'read', sideEffectLevel: 'none' });
      expect(mistagged.executed, name).not.toContain(name);
      expect(mistagged.results[0]?.ok, name).toBe(false);
      expect(mistagged.metadata?.handoffState, name).toBe('planner_readonly');
    }
  });

  it('keeps auto eligibility for a non-object capabilityTiers value and records a warning', async () => {
    const metadata = {
      handoffEnablement: { source: 'auto_policy' },
      capabilityTiers: 'bad',
    };
    const gate = trajectoryHandoffGateFromMetadata(metadata);
    expect(gate.path).toBe('auto_eligible');
    expect(gate.enablementSource).not.toBe('explicit_off');
    expect(handoffRuntimeEnabled(metadata)).toBe(false);
    const hosted = sessionHost('chat', metadata);
    const entered = await enterAutoPlannerReadonly(hosted.host, hosted.sessionId);
    expect(entered.ok).toBe(true);
    const stored = hosted.surface.getSession(hosted.sessionId)?.metadata;
    expect(typeof stored?.handoffTierWarning).toBe('string');
    expect(String(stored?.handoffTierWarning).length).toBeGreaterThan(0);
    expect(stored?.handoffState).toBe('planner_readonly');
    const source = enablementSourceOf(stored?.capabilityTiers);
    if (source !== undefined) expect(source).not.toBe('explicit_off');
  });

  it('does not execute a later write once an auto_policy handoff is answered', async () => {
    const metadata = {
      ...autoMetadata(),
      handoffState: 'answered',
      handoffKernel: {
        state: 'answered',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 0 },
        enteredAt: '2026-01-01T00:00:00.000Z',
        turnNumber: 1,
      },
    };
    expect(trajectoryHandoffGateFromMetadata(metadata).path).toBe('in_machine');
    const execute = vi.fn(async () => ({ ok: true, content: 'wrote' }));
    const write = await runTool(
      metadata,
      tool('write_file', execute, { access: 'edit', sideEffectLevel: 'workspace' }),
    );
    expect(typeof write.denied).toBe('string');
    expect(execute).not.toHaveBeenCalled();
    expect(write.result.ok).toBe(false);
  });

  it('keeps a session-capped auto_policy session on the old path and does not clear the count', async () => {
    const metadata = {
      ...autoMetadata(),
      handoffSuspended: 'session_cap',
      handoffSessionCount: 6,
    };
    expect(trajectoryHandoffGateFromMetadata(metadata).path).toBe('mechanism_off');
    expect(handoffRuntimeEnabled(metadata)).toBe(false);
    const execute = vi.fn(async () => ({ ok: true, content: 'wrote' }));
    const write = await runTool(
      metadata,
      tool('write_file', execute, { access: 'edit', sideEffectLevel: 'workspace' }),
    );
    expect(write.denied).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(write.result.ok).toBe(true);
    expect(write.session.metadata.handoffSessionCount).toBe(6);
    expect(write.session.metadata.handoffSuspended).toBe('session_cap');
    expect(write.session.metadata.handoffState).not.toBe('planner_readonly');

    const hosted = sessionHost('chat', {
      ...autoMetadata(),
      handoffSuspended: 'session_cap',
      handoffSessionCount: 6,
    });
    await prepareExplicitSessionHandoff(hosted.host, hosted.sessionId, { userTurn: true });
    const stored = hosted.surface.getSession(hosted.sessionId);
    expect(stored?.metadata?.handoffSessionCount).toBe(6);
    expect(stored?.metadata?.handoffSuspended).toBe('session_cap');
    expect(stored?.metadata?.handoffState).not.toBe('planner_readonly');
    expect(trajectoryHandoffGateFromMetadata(stored?.metadata).path).toBe('mechanism_off');
  });

  it('enters planner_readonly at the task user turn and leaves chat auto_eligible until a controlled tool', async () => {
    const task = sessionHost('task', autoMetadata());
    expect(trajectoryHandoffGateFromMetadata(task.surface.getSession(task.sessionId)?.metadata).path).toBe('auto_eligible');
    await prepareExplicitSessionHandoff(task.host, task.sessionId, { userTurn: true });
    const taskMetadata = task.surface.getSession(task.sessionId)?.metadata;
    expect(taskMetadata?.handoffState).toBe('planner_readonly');
    expect(trajectoryHandoffGateFromMetadata(taskMetadata).path).toBe('in_machine');

    const chat = sessionHost('chat', autoMetadata());
    await prepareExplicitSessionHandoff(chat.host, chat.sessionId, { userTurn: true });
    const chatMetadata = chat.surface.getSession(chat.sessionId)?.metadata;
    expect(chatMetadata?.handoffState).toBeUndefined();
    expect(trajectoryHandoffGateFromMetadata(chatMetadata).path).toBe('auto_eligible');
    expect(handoffRuntimeEnabled(chatMetadata)).toBe(false);
  });
});