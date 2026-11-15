import { afterEach, describe, expect, it } from 'vitest';
import { PATTERN_B_PRODUCTION_ENTRY, type BoundaryRegistry } from './types.js';
import { canonicalPath } from './paths.js';
import { clearHostBoundaries, hostBoundaryKey, installHostBoundary } from './host-registry.js';
import { denyPatternBTool, patternBBoundaryPending } from './tool-gate.js';
import { executeAutoEligibleToolWave, finishTrajectoryWrite, noteTrajectoryWrite, prepareTrajectoryToolWave } from '../tool-entry.js';
import * as handoff from '../index.js';

const writeTool = { name: 'write_file', access: 'write', sideEffectLevel: 'write' };
const readTool = { name: 'read_file', access: 'read', sideEffectLevel: 'none' };

function registry(role: 'executor' | 'planner' = 'executor'): BoundaryRegistry {
  return {
    hostEnforced: true,
    canonicalize: canonicalPath,
    boundaries: [
      {
        identity: { runId: 'run', workerId: 'w1', taskScope: 'scope', planId: 'plan', planVersion: '3' },
        writableRoot: '/work/w1',
        role,
        effectiveWrite: role === 'executor',
      },
      {
        identity: { runId: 'run', workerId: 'w2', taskScope: 'scope', planId: 'plan', planVersion: '3' },
        writableRoot: '/work/w2',
        role: 'executor',
        effectiveWrite: true,
      },
    ],
    readOnlyMounts: [{ path: '/work/ro', kind: 'input' as const }],
    sharedTargets: [{ targetId: 'shared', path: '/shared', expectedVersion: 'v1' }],
  };
}

function session(extra: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    metadata: {
      patternBHostKey: hostBoundaryKey('run', 'w1'),
      patternBRunId: 'run',
      patternBWorkerId: 'w1',
      patternBTaskScope: 'scope',
      patternBRole: 'executor',
      patternBPlanId: 'plan',
      patternBPlanVersion: '3',
      ...extra,
    },
  };
}

afterEach(() => {
  clearHostBoundaries();
});

describe('Pattern B tool gate', () => {
  it('keeps production entry closed and out of the handoff barrel', () => {
    expect(PATTERN_B_PRODUCTION_ENTRY).toBe('closed');
    expect('admitProductionWrite' in handoff).toBe(false);
    expect('admitWorkerWrite' in handoff).toBe(false);
    expect('createMemoryIntegrationStore' in handoff).toBe(false);
    expect('createMemoryLifecycleStore' in handoff).toBe(false);
  });

  it('allows an isolated write on the worker root and denies every other target', () => {
    installHostBoundary(hostBoundaryKey('run', 'w1'), registry());
    const live = session();
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1/a.ts' } })).toBeUndefined();
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1-evil/a.ts' } })).toMatch(/outside/);
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w2/a.ts' } })).toMatch(/Another worker/);
    expect(denyPatternBTool(live, writeTool, { input: { path: '/shared/out.ts' } })).toMatch(/Shared integration/);
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/ro/input.ts' } })).toMatch(/Read-only/);
    expect(denyPatternBTool(live, readTool, { input: { path: '/shared/out.ts' } })).toBeUndefined();
  });

  it('applies the same path rule to shell, http, browser, mcp, and command text', () => {
    installHostBoundary(hostBoundaryKey('run', 'w1'), registry());
    const live = session();
    const channels = ['shell', 'http', 'browser', 'mcp', 'subagent', 'dynamic', 'batch'] as const;
    for (const channel of channels) {
      expect(denyPatternBTool(live, { name: channel, access: 'read' }, {
        channel,
        input: { path: '/shared/out' },
      })).toMatch(/Shared integration/);
      expect(denyPatternBTool(live, { name: channel, access: 'read' }, {
        channel,
        input: { cwd: '/work/w1' },
      })).toBeUndefined();
    }
    expect(denyPatternBTool(live, { name: 'bash', access: 'read' }, {
      input: { command: 'cp /work/w1/a.ts /shared/out' },
    })).toMatch(/Shared integration/);
    expect(denyPatternBTool(live, { name: 'bash', access: 'read' }, {
      input: { command: 'npm test' },
    })).toBeTruthy();
  });

  it('does not let a planner, reviewer, or role switch gain a write', () => {
    installHostBoundary(hostBoundaryKey('run', 'w1'), registry('planner'));
    const live = session({ patternBRole: 'planner' });
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1/a.ts' }, role: 'executor' })).toMatch(/Planner/);
    expect(denyPatternBTool(live, { name: 'cleanup_workspace' }, { input: { path: '/work/w1' } })).toMatch(/host-controlled/);
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1/a.ts' }, sharedScopeChange: true })).toMatch(/Shared scope/);
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1/a.ts' }, workerClaimsSkipGate: true })).toMatch(/self-report/);
  });

  it('fails closed when the host key is not an installed enforced boundary', () => {
    const live = session();
    expect(denyPatternBTool(live, writeTool, { input: { path: '/work/w1/a.ts' } })).toMatch(/not host-enforced/);
    expect(denyPatternBTool(live, readTool, { input: { path: '/shared/x' } })).toBeUndefined();
    expect(denyPatternBTool({ metadata: {} }, writeTool, { input: { path: '/shared/x' } })).toBeUndefined();
  });

  it('stops in-flight writes before a planner boundary and does not execute a denied shell', async () => {
    installHostBoundary(hostBoundaryKey('run', 'w1'), registry());
    const live = session({ handoffEntering: 'planner_readonly' });
    noteTrajectoryWrite(live.id, 'call-1');
    const prepared = await prepareTrajectoryToolWave(live);
    expect(prepared.ok).toBe(false);
    expect(patternBBoundaryPending(live.metadata, true)?.ok).toBe(false);
    const executed: string[] = [];
    const results = await executeAutoEligibleToolWave({
      session: live,
      calls: [
        { toolCallId: 'ok', name: 'read_file', input: { path: '/shared/x' } },
        { toolCallId: 'bad', name: 'bash', input: { command: 'tee /shared/out' } },
      ],
      tools: [readTool, { name: 'bash', access: 'read' }],
      execute: async (calls) => {
        executed.push(...calls.map((call) => call.toolCallId));
        return calls.map((call) => ({ toolCallId: call.toolCallId, name: call.name, ok: true, content: 'ran' }));
      },
      enterPlanner: async () => ({ ok: true }),
    });
    expect(executed).toEqual(['ok']);
    expect(results.find((result) => result.toolCallId === 'bad')?.ok).toBe(false);
    finishTrajectoryWrite(live.id, 'call-1');
  });
});
