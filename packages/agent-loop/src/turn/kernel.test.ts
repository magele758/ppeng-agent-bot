import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRunProfile } from '../runtime/run-profile.js';
import { CHECKPOINTS_METADATA_KEY } from '../session/checkpoint.js';
import { createWaitingApprovalInterrupt } from '../session/interrupt.js';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import { TOOL_WAVE_INTERRUPTED_CONTENT } from '../session/tool-wave-close.js';
import { unmatchedToolCallIds } from '../session/surface-invariants.js';
import { appendWorkingLogEntry, readWorkingLogTail, workingLogPath } from '../session/working-log.js';
import type { AgentSpec, ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';
import type { TurnKernelHost, TurnKernelStore } from './host.js';
import { createKernelHookRegistry } from './hooks.js';
import { runSessionKernel } from './kernel.js';
import { WORKING_LOG_APPENDIX_HEAD } from './prepare-turn-input.js';

function agent(): AgentSpec {
  return {
    id: 'agent-1',
    name: 'Test',
    role: 'assistant',
    instructions: 'test',
    capabilities: [],
  };
}

function textResult(text: string): ModelTurnResult {
  return { stopReason: 'end', assistantParts: [{ type: 'text', text }] };
}

function toolResult(name: string, id = 'call-1'): ModelTurnResult {
  return {
    stopReason: 'tool_use',
    assistantParts: [{ type: 'tool_call', toolCallId: id, name, input: {} }],
  };
}

function stubAdapter(impl: () => Promise<ModelTurnResult> | ModelTurnResult): ModelAdapter {
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
  model?: () => Promise<ModelTurnResult> | ModelTurnResult;
  host?: Partial<TurnKernelHost>;
}) {
  const surface = createMemorySurfaceStore();
  const spec = agent();
  const session = surface.createSession({ title: 't', mode: 'chat', agentId: spec.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);

  const approvals: Array<{
    id: string;
    sessionId: string;
    toolName: string;
    status: 'pending' | 'approved' | 'rejected';
    args: Record<string, unknown>;
    createdAt: string;
  }> = [];

  const store: TurnKernelStore = {
    getSession: (id) => surface.getSession(id),
    updateSession: (id, patch) => surface.updateSession(id, patch),
    foldMessages: (id) => surface.foldMessages(id),
    appendMessage: (id, role, parts, appendOpts) =>
      surface.appendMessage(id, role, parts, appendOpts),
    appendReplacement: (id, input) => surface.appendReplacement(id, input),
    getAgent: (id) => (id === spec.id ? spec : undefined),
    claimWriter: (id, runId) => surface.claimWriter(id, runId),
    releaseWriter: (id, runId) => surface.releaseWriter(id, runId),
    listApprovals: (filter) =>
      filter?.status ? approvals.filter((a) => a.status === filter.status) : approvals,
    claimInbox: (id, target) => surface.claimInbox(id, target),
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, opts) => surface.hideRange(id, start, end, opts),
    getDaemonControl: () => undefined,
  };

  const calls = {
    mcp: 0,
    resolveTools: 0,
    goal: 0,
    lifecycle: [] as string[],
    execute: 0,
    tx: [] as string[],
  };

  const echo: ToolContract = {
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: 'ok' }),
  };

  const host: TurnKernelHost = {
    store,
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/state',
    modelAdapter: stubAdapter(opts?.model ?? (() => textResult('done'))),
    promptBuilder: {
      buildSystemPrompt: async () => 'sys',
      buildMemoryAppendix: () => '',
    },
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
      return toolCalls.map((c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        ok: true,
        content: 'ok',
      }));
    },
    prepareMessagesForModel: async (_s, messages) => messages,
    autoCompact: async () => ({}),
    handleTurnCompletion: async (s) => store.updateSession(s.id, { status: 'idle' }),
    processToolResults: (results, _calls, _session, _task, sessionId) => {
      store.appendMessage(
        sessionId,
        'tool',
        results.map((r) => ({
          type: 'tool_result' as const,
          toolCallId: r.toolCallId,
          name: r.name,
          ok: r.ok,
          content: r.content,
        }))
      );
    },
    ...opts?.host,
  };

  return { host, store, session, surface, spec, calls, echo };
}

describe('runSessionKernel wiring', () => {
  it('completes without optional hooks (compat)', async () => {
    const { host, session } = createHarness();
    const out = await runSessionKernel(host, session.id);
    expect(out.status).toBe('idle');
  });

  it('calls ensureMcpLoaded, resolveTurnTools, evaluateGoalGate, runLifecycleHook', async () => {
    const seen: string[] = [];
    let goalTurns = 0;
    const { host, session, echo } = createHarness({
      model: () => textResult('answer'),
      host: {
        maxTurnsPerRun: 3,
        ensureMcpLoaded: async () => {
          seen.push('mcp');
        },
        resolveTurnTools: () => {
          seen.push('tools');
          return { tools: [echo], allowExternalAiTools: true };
        },
        runLifecycleHook: async ({ phase }) => {
          seen.push(phase);
          return {};
        },
        evaluateGoalGate: async () => {
          goalTurns += 1;
          seen.push('goal');
          return goalTurns === 1 ? { met: false, reason: 'keep going' } : { met: true };
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(seen[0]).toBe('mcp');
    expect(seen).toContain('tools');
    expect(seen).toContain('session_start');
    expect(seen).toContain('before_turn');
    expect(seen).toContain('goal');
    expect(seen).toContain('stop');
    expect(goalTurns).toBe(2);
  });

  it('does not silently drop resolveTurnTools tools', async () => {
    let names: string[] = [];
    const extra: ToolContract = {
      name: 'dyn_echo',
      description: 'dyn',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'dyn' }),
    };
    const { host, session } = createHarness({
      host: {
        resolveTurnTools: () => ({ tools: [extra], allowExternalAiTools: false }),
        runTurnWithRetries: async (input) => {
          names = input.tools.map((t) => t.name);
          return textResult('ok');
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(names).toEqual(['dyn_echo']);
  });

  it('drains steer before opening a tool wave', async () => {
    let executed = 0;
    const { host, session, surface } = createHarness({
      model: () => toolResult('echo'),
      host: {
        executeToolCalls: async () => {
          executed += 1;
          return [];
        },
      },
    });
    const orig = host.runTurnWithRetries;
    host.runTurnWithRetries = async (input, onStream) => {
      surface.enqueueSteer(session.id, 'stop and listen', { target: 'next-step' });
      return orig(input, onStream);
    };
    host.store.updateSession(session.id, {
      metadata: { ...(host.store.getSession(session.id)?.metadata ?? {}), steerDrainPolicy: 'tool_launch' },
    });
    await runSessionKernel(host, session.id, { steerDrainPolicy: 'tool_launch' });
    expect(executed).toBe(0);
    const folded = host.store.foldMessages(session.id);
    expect(unmatchedToolCallIds(folded)).toEqual([]);
  });

  it('closes an open tool wave on abort latch', async () => {
    const { host, session } = createHarness({
      model: () => toolResult('echo', 'abort-call'),
      host: {
        shouldLatchBeforeTools: () => 'steer',
        executeToolCalls: async () => {
          throw new Error('should not execute');
        },
      },
    });
    const out = await runSessionKernel(host, session.id);
    expect(out.status).toBe('idle');
    const folded = host.store.foldMessages(session.id);
    expect(unmatchedToolCallIds(folded)).toEqual([]);
    const result = folded.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
    expect(result && result.type === 'tool_result' ? result.content : '').toContain('interrupted');
    expect(TOOL_WAVE_INTERRUPTED_CONTENT).toBeTruthy();
  });

  it('rolls back an open step when the model throws and pairing cannot recover', async () => {
    const tx: string[] = [];
    const { host, session } = createHarness({
      host: {
        stepTx: {
          beginStep: () => {
            tx.push('begin');
          },
          commitStep: () => {
            tx.push('commit');
          },
          rollbackUncommitted: (reason) => {
            tx.push(`rollback:${reason}`);
          },
        },
        runTurnWithRetries: async () => {
          throw new Error('upstream 500');
        },
      },
    });
    await expect(runSessionKernel(host, session.id)).rejects.toThrow('upstream 500');
    expect(tx.some((x) => x.startsWith('rollback:'))).toBe(true);
  });

  it('pairs unmatched tool_calls before the next model turn', async () => {
    let firstFoldHasResult = false;
    const { host, session } = createHarness({
      host: {
        runTurnWithRetries: async (input) => {
          firstFoldHasResult = input.messages.some((m) =>
            m.parts.some((p) => p.type === 'tool_result' && p.toolCallId === 'orphan-1')
          );
          return textResult('ok');
        },
      },
    });
    host.store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'orphan-1', name: 'echo', input: {} },
    ]);
    await runSessionKernel(host, session.id);
    expect(firstFoldHasResult).toBe(true);
  });

  it('recovers model-behavior errors by synthesizing pending tool results', async () => {
    let turns = 0;
    const { host, session } = createHarness({
      host: {
        maxTurnsPerRun: 3,
        runTurnWithRetries: async () => {
          turns += 1;
          if (turns === 1) {
            host.store.appendMessage(session.id, 'assistant', [
              { type: 'tool_call', toolCallId: 'pending-1', name: 'echo', input: {} },
            ]);
            throw new Error('Tool echo is not available');
          }
          return textResult('recovered');
        },
      },
    });
    const out = await runSessionKernel(host, session.id);
    expect(out.status).toBe('idle');
    expect(turns).toBeGreaterThanOrEqual(2);
    const folded = host.store.foldMessages(session.id);
    expect(unmatchedToolCallIds(folded)).toEqual([]);
  });

  it('passes filePolicy into checkToolApprovals extras', async () => {
    let extras: unknown;
    const { host, session } = createHarness({
      model: () => toolResult('echo'),
      host: {
        resolveFilePolicy: () => ({ requireApprovalForBash: true }),
        checkToolApprovals: (_calls, _ctx, _session, extra) => {
          extras = extra;
          return 'skip';
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(extras).toMatchObject({ filePolicy: { requireApprovalForBash: true } });
  });

  it('calls autoCompact every turn and injects appendix on the model view only', async () => {
    let turns = 0;
    let compactCalls = 0;
    const seenAppendix: boolean[] = [];
    const { host, session, store } = createHarness({
      host: {
        maxTurnsPerRun: 3,
        autoCompact: async () => {
          compactCalls += 1;
          return {};
        },
        promptBuilder: {
          buildSystemPrompt: async () => 'sys',
          buildMemoryAppendix: () => '[memory] appendix',
        },
        runTurnWithRetries: async (input) => {
          turns += 1;
          seenAppendix.push(
            input.messages.some((m) =>
              m.parts.some((p) => p.type === 'text' && p.text.includes('[memory] appendix'))
            )
          );
          if (turns === 1) {
            return {
              stopReason: 'end',
              assistantParts: [{ type: 'text', text: 'first' }],
            };
          }
          return textResult('done');
        },
        evaluateGoalGate: async () =>
          turns === 1 ? { met: false, reason: 'again', action: 'continue' } : { met: true },
      },
    });
    await runSessionKernel(host, session.id);
    expect(compactCalls).toBeGreaterThanOrEqual(2);
    expect(seenAppendix.every(Boolean)).toBe(true);
    const wal = store.foldMessages(session.id);
    expect(
      wal.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('[memory] appendix')))
    ).toBe(false);
  });

  it('does not count-slice history that still fits the token budget', async () => {
    let seen = 0;
    const { host, session } = createHarness({
      host: {
        loopConfig: { maxVisibleMessages: 3, foldBudgetClamp: true },
        runTurnWithRetries: async (input) => {
          seen = input.messages.length;
          const text = input.messages.flatMap((m) =>
            m.parts.filter((p) => p.type === 'text').map((p) => p.text)
          );
          expect(text).toContain('hi');
          expect(text).toContain('pad-0');
          return textResult('ok');
        },
      },
    });
    for (let i = 0; i < 8; i += 1) {
      host.store.appendMessage(session.id, i % 2 ? 'assistant' : 'user', [
        { type: 'text', text: `pad-${i}` },
      ]);
    }
    await runSessionKernel(host, session.id);
    expect(seen).toBeGreaterThan(3);
  });

  it('keeps the latest user when summary does not shrink an over-budget fold', async () => {
    let roles: string[] = [];
    let sawQuestion = false;
    const { host, session } = createHarness({
      host: {
        env: { RAW_AGENT_COMPACT_TOKEN_THRESHOLD: '80' },
        autoCompact: async () => ({}),
        loopConfig: { maxVisibleMessages: 3, foldBudgetClamp: true },
        runTurnWithRetries: async (input) => {
          roles = input.messages.map((m) => m.role);
          sawQuestion = input.messages.some(
            (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'hi')
          );
          const open = new Set<string>();
          for (const message of input.messages) {
            const calls: string[] = [];
            const results: string[] = [];
            for (const part of message.parts) {
              if (part.type === 'tool_call') calls.push(part.toolCallId);
              if (part.type === 'tool_result') results.push(part.toolCallId);
            }
            for (const id of results) expect(open.has(id)).toBe(true);
            for (const id of calls) open.add(id);
            for (const id of results) open.delete(id);
          }
          return textResult('ok');
        },
      },
    });
    for (let w = 0; w < 12; w += 1) {
      host.store.appendMessage(session.id, 'assistant', [
        { type: 'tool_call', toolCallId: `c${w}a`, name: 'navigate_tab', input: {} },
        { type: 'tool_call', toolCallId: `c${w}b`, name: 'get_page_info', input: {} },
      ]);
      host.store.appendMessage(session.id, 'tool', [
        {
          type: 'tool_result',
          toolCallId: `c${w}a`,
          name: 'navigate_tab',
          ok: true,
          content: 'x'.repeat(500),
        },
      ]);
      host.store.appendMessage(session.id, 'tool', [
        {
          type: 'tool_result',
          toolCallId: `c${w}b`,
          name: 'get_page_info',
          ok: true,
          content: 'x'.repeat(500),
        },
      ]);
    }
    await runSessionKernel(host, session.id);
    expect(sawQuestion).toBe(true);
    expect(roles[0]).not.toBe('tool');
  });

  it('delivers latch + hooks + onEvent for turn_prepared / ended', async () => {
    const seen: string[] = [];
    const { host, session } = createHarness();
    const hooks = createKernelHookRegistry();
    hooks.register((ev) => {
      seen.push(`hook:${ev.type}`);
    });
    await runSessionKernel(host, session.id, {
      latch: {
        emit: async (ev) => {
          seen.push(`latch:${ev.type}`);
        },
      },
      hooks,
      onEvent: (ev) => {
        seen.push(`on:${ev.type}`);
      },
    });
    expect(seen.some((s) => s === 'latch:turn_prepared')).toBe(true);
    expect(seen.some((s) => s === 'hook:turn_prepared')).toBe(true);
    expect(seen.some((s) => s === 'on:ended')).toBe(true);
  });

  it('falls back to working-log tail when memory appendix is empty', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'al-kernel-wlog-'));
    const { host, session, store } = createHarness({
      host: {
        stateDir,
        readWorkingLogAppendix: (id) => readWorkingLogTail(workingLogPath(stateDir, id)),
      },
    });
    appendWorkingLogEntry(workingLogPath(stateDir, session.id), {
      kind: 'step_outcome',
      content: 'compact survived this fact',
    });
    let sawTail = false;
    host.runTurnWithRetries = async (input) => {
      sawTail = input.messages.some((m) =>
        m.parts.some(
          (p) =>
            p.type === 'text' &&
            p.text.includes(WORKING_LOG_APPENDIX_HEAD) &&
            p.text.includes('compact survived this fact')
        )
      );
      return textResult('ok');
    };
    try {
      await runSessionKernel(host, session.id);
      expect(sawTail).toBe(true);
      const wal = store.foldMessages(session.id);
      expect(
        wal.some((m) =>
          m.parts.some((p) => p.type === 'text' && p.text.includes(WORKING_LOG_APPENDIX_HEAD))
        )
      ).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('calls resolveRunProfile when preparing a turn and resolving tools', async () => {
    const phases: string[] = [];
    const { host, session, echo } = createHarness({
      host: {
        resolveRunProfile: () => {
          phases.push('profile');
          return resolveRunProfile('auto');
        },
        resolveTurnTools: () => {
          phases.push('tools');
          return { tools: [echo], allowExternalAiTools: false };
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(phases).toContain('profile');
    expect(phases).toContain('tools');
    expect(phases.indexOf('profile')).toBeLessThan(phases.indexOf('tools'));
    expect(phases.filter((p) => p === 'profile').length).toBeGreaterThanOrEqual(2);
  });

  it('treats maxTurns<=0 as unlimited and still runs a turn', async () => {
    let calls = 0;
    const { host, session } = createHarness({
      model: () => {
        calls += 1;
        return textResult('ok');
      },
      host: { maxTurnsPerRun: 0, loopConfig: { maxTurns: 0 } },
    });
    const out = await runSessionKernel(host, session.id);
    expect(calls).toBe(1);
    expect(out.status).toBe('idle');
  });

  it('empties tools on the last finite turn', async () => {
    let names: string[] = ['sentinel'];
    const { host, session, echo } = createHarness({
      host: {
        maxTurnsPerRun: 1,
        resolveTurnTools: () => ({ tools: [echo], allowExternalAiTools: true }),
        runTurnWithRetries: async (input) => {
          names = input.tools.map((t) => t.name);
          return textResult('final');
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(names).toEqual([]);
  });

  it('does not re-union resolveTurnTools against host.tools', async () => {
    let names: string[] = [];
    const extra: ToolContract = {
      name: 'dyn_echo',
      description: 'dyn',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'dyn' }),
    };
    const spawn: ToolContract = {
      name: 'spawn_subagent',
      description: 'spawn',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'spawn' }),
    };
    const { host, session } = createHarness({
      host: {
        tools: [spawn],
        resolveRunProfile: () => resolveRunProfile('teams'),
        resolveTurnTools: () => ({ tools: [extra], allowExternalAiTools: false }),
        runTurnWithRetries: async (input) => {
          names = input.tools.map((t) => t.name);
          return textResult('ok');
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(names).toEqual(['dyn_echo']);
  });

  it('stops after a successful stopAt tool', async () => {
    let modelCalls = 0;
    const { host, session } = createHarness({
      model: () => {
        modelCalls += 1;
        return toolResult('echo', 'stop-1');
      },
      host: {
        maxTurnsPerRun: 4,
        loopConfig: { stopAtToolNames: ['echo'] },
      },
    });
    const out = await runSessionKernel(host, session.id);
    expect(modelCalls).toBe(1);
    expect(out.metadata?.outcome).toMatchObject({ reason: 'stop_at:echo' });
  });

  it('skips appendix on overflow reprepare', async () => {
    let appendixCalls = 0;
    let turns = 0;
    const { host, session } = createHarness({
      host: {
        maxTurnsPerRun: 2,
        promptBuilder: {
          buildSystemPrompt: async () => 'sys',
          buildMemoryAppendix: () => {
            appendixCalls += 1;
            return 'MEM';
          },
        },
        runTurnWithRetries: async () => {
          turns += 1;
          if (turns === 1) {
            throw new Error('context_length_exceeded');
          }
          return textResult('recovered');
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(appendixCalls).toBe(1);
  });

  it('composes promptCacheKey from turn tools, epoch, and bust key', async () => {
    let cacheKey: string | undefined;
    const { host, session, echo } = createHarness({
      host: {
        promptCacheEpoch: 7,
        loopConfig: { promptCacheBustKey: 'bust' },
        resolveTurnTools: () => ({
          tools: [echo],
          allowExternalAiTools: false,
          promptCacheKey: 'toolset',
        }),
        runTurnWithRetries: async (input) => {
          cacheKey = input.promptCacheKey;
          return textResult('ok');
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(cacheKey).toBe('toolset:7:bust');
  });

  it('promotes reasoning to text when the assistant body is empty', async () => {
    const { host, session, store } = createHarness({
      model: () => ({
        stopReason: 'end',
        assistantParts: [{ type: 'reasoning', text: 'the real answer' }],
      }),
    });
    await runSessionKernel(host, session.id);
    const fold = store.foldMessages(session.id);
    const texts = fold.flatMap((m) =>
      m.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : ''))
    );
    expect(texts).toContain('the real answer');
  });

  it('resumes interrupt tools with resolved turn tools and allowExternal', async () => {
    let seen: { allow?: boolean; names?: string[] } = {};
    const extra: ToolContract = {
      name: 'dyn_echo',
      description: 'dyn',
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: 'dyn' }),
    };
    const { host, session, surface } = createHarness({
      model: () => textResult('after resume'),
      host: {
        resolveTurnTools: () => ({ tools: [extra], allowExternalAiTools: true }),
        executeToolCalls: async (calls, _ctx, allowExternal, _sid, turnTools) => {
          seen = { allow: allowExternal, names: (turnTools ?? []).map((t) => t.name) };
          return calls.map((c) => ({
            toolCallId: c.toolCallId,
            name: c.name,
            ok: true,
            content: 'ok',
          }));
        },
      },
    });
    surface.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'resume-1', name: 'dyn_echo', input: {} },
    ]);
    host.store.updateSession(session.id, {
      metadata: {
        interrupt: createWaitingApprovalInterrupt({
          toolCallIds: ['resume-1'],
          approvalIds: [],
        }),
      },
    });
    await runSessionKernel(host, session.id);
    expect(seen.allow).toBe(true);
    expect(seen.names).toEqual(['dyn_echo']);
  });

  it('rewinds uncommitted tail on finishFailed', async () => {
    const { host, session, store, surface } = createHarness({
      host: {
        runTurnWithRetries: async () => {
          throw new Error('boom-no-recover');
        },
      },
    });
    const userSeq = store.foldMessages(session.id).at(-1)?.seq ?? 1;
    host.store.updateSession(session.id, {
      metadata: {
        [CHECKPOINTS_METADATA_KEY]: [
          {
            id: 'ck-1',
            sessionId: session.id,
            seq: userSeq,
            turn: 0,
            label: 'closed',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    surface.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'uncommitted' }]);
    await expect(runSessionKernel(host, session.id)).rejects.toThrow('boom-no-recover');
    const fold = store.foldMessages(session.id);
    expect(fold.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'uncommitted'))).toBe(
      false
    );
  });

  it('replaces last-turn tool calls with fallback copy', async () => {
    const { host, session, store } = createHarness({
      model: () => ({
        stopReason: 'tool_use',
        finishReason: 'tool_calls',
        assistantParts: [
          { type: 'text', text: 'I will keep searching.' },
          { type: 'tool_call', toolCallId: 'c1', name: 'echo', input: {} },
        ],
      }),
      host: {
        maxTurnsPerRun: 1,
        loopConfig: {
          forceAnswerOnLastTurn: true,
          lastTurnFallback: '到上限了',
        },
        executeToolCalls: async () => {
          throw new Error('must not run');
        },
      },
    });
    await runSessionKernel(host, session.id);
    const fold = store.foldMessages(session.id);
    const last = fold.filter((m) => m.role === 'assistant').at(-1);
    expect(last?.parts.some((p) => p.type === 'text' && p.text.includes('到上限了'))).toBe(true);
    expect(last?.parts.some((p) => p.type === 'tool_call')).toBe(false);
  });

  it('emits onSessionOutcome partial for max_turns', async () => {
    const outcomes: Array<{ outcome: string; reason?: unknown }> = [];
    const { host, session } = createHarness({
      model: () => toolResult('echo', `c-${Date.now()}`),
      host: {
        maxTurnsPerRun: 1,
        loopConfig: { forceAnswerOnLastTurn: false },
        onSessionOutcome: (input) => {
          outcomes.push({ outcome: input.outcome, reason: input.signals?.reason });
        },
      },
    });
    await runSessionKernel(host, session.id);
    expect(outcomes.some((o) => o.outcome === 'partial' && o.reason === 'max_turns_exhausted')).toBe(
      true
    );
  });
});
