import { describe, expect, it, vi } from 'vitest';
import { executeSingleTool, type ToolLoopHost } from '../runtime/tool-loop.js';
import type { RunContext, ToolContract } from '../types.js';
import { noteTrajectoryWrite, prepareTrajectoryToolWave } from './tool-entry.js';

function host(): ToolLoopHost {
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
  extra: Partial<ToolContract<Record<string, unknown>>> = {}
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

function context(metadata: Record<string, unknown> | undefined): RunContext {
  return { session: { id: 's1', metadata } } as RunContext;
}

const call = {
  type: 'tool_call' as const,
  toolCallId: 'tc1',
  name: 'read_file',
  input: {},
};

async function run(metadata: Record<string, unknown> | undefined, spec: ToolContract<Record<string, unknown>>) {
  return executeSingleTool(host(), [spec], call, context(metadata), false, 's1');
}

const explicit = {
  capabilityTiers: { enabled: true },
  handoffRole: 'planner',
  handoffState: 'planner_readonly',
};

describe('trajectory tool entry', () => {
  it('denies a bash-class tool in planner even when the tool is named read_file [AC:trajectory-handoff-explicit#TH-4]', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: 'ran' }));
    const result = await run(explicit, tool('read_file', execute, { access: 'bash', sideEffectLevel: 'system' }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('allows a read-class tool in planner', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: 'body' }));
    const result = await run(explicit, tool('read_file', execute, { access: 'read', sideEffectLevel: 'none' }));
    expect(execute).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('denies a write when the executor original set is read-only', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: 'wrote' }));
    const result = await run(
      {
        capabilityTiers: { enabled: true },
        handoffRole: 'executor',
        handoffState: 'executor_write',
        originalPerms: ['read'],
      },
      tool('read_file', execute, { access: 'edit', sideEffectLevel: 'workspace' })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('denies a write during a research host phase', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: 'wrote' }));
    const result = await run(
      {
        capabilityTiers: { enabled: true },
        handoffRole: 'executor',
        handoffState: 'executor_write',
        hostPhase: 'research',
      },
      tool('read_file', execute, { access: 'edit', sideEffectLevel: 'workspace' })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('leaves the production path alone when tiers are missing [AC:trajectory-handoff-explicit#TH-1]', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: 'ran' }));
    const result = await run(undefined, tool('read_file', execute, { access: 'bash', sideEffectLevel: 'system' }));
    expect(execute).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('fails closed immediately when a write is still in flight at planner entry', async () => {
    noteTrajectoryWrite('s-drain', 'w1');
    const prepared = await prepareTrajectoryToolWave({
      id: 's-drain',
      metadata: { capabilityTiers: { enabled: true }, handoffState: 'planner_readonly' },
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.reason).not.toContain('5000');
  });
});
