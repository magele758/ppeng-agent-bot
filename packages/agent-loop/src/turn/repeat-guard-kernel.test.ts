import { describe, expect, it } from 'vitest';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import type { AgentSpec, MessagePart, ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';
import type { TurnKernelHost, TurnKernelStore } from './host.js';
import { runSessionKernel } from './kernel.js';

function agent(): AgentSpec {
  return {
    id: 'agent-1',
    name: 'Test',
    role: 'assistant',
    instructions: 'test',
    capabilities: [],
  };
}

function viewTool(name: string): ToolContract {
  return {
    name,
    description: name,
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: 'file contents' }),
  };
}

function createHarness() {
  const surface = createMemorySurfaceStore();
  const spec = agent();
  const session = surface.createSession({ title: 't', mode: 'chat', agentId: spec.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
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
    claimInbox: () => [],
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, opts) => surface.hideRange(id, start, end, opts),
    getDaemonControl: () => undefined,
  };
  const calls = { execute: 0 };
  const host: TurnKernelHost = {
    store,
    repoRoot: '/tmp/repo',
    stateDir: '/tmp/state',
    modelAdapter: {
      name: 'heuristic',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
    promptBuilder: {
      buildSystemPrompt: async () => 'sys',
      buildMemoryAppendix: () => '',
    },
    tools: [viewTool('read_file'), viewTool('grep_files'), viewTool('bash')],
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
        content: 'file contents',
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
  };
  return { host, store, session, calls };
}

function systemText(store: TurnKernelStore, id: string): string {
  return store
    .foldMessages(id)
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.parts)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function outcomeOf(store: TurnKernelStore, id: string): { reason: string; failureStage?: string } {
  const outcome = store.getSession(id)?.metadata?.outcome as
    | { reason?: string; failureStage?: string }
    | undefined;
  return { reason: outcome?.reason ?? '', failureStage: outcome?.failureStage };
}

async function runRepeated(opts: {
  adapterName: string;
  modelName?: string;
  repeatGuard?: 'weak' | 'all' | 'off';
  guardBag?: { repeatGuard?: 'weak' | 'all' | 'off' };
  maxTurns?: number;
  sameToolStreak?: string;
  failStreak?: string;
  fail?: boolean;
  prose?: boolean;
  onRound?: (round: number) => void;
}) {
  const { host, store, session, calls } = createHarness();
  const bag = opts.guardBag ?? {};
  if (opts.repeatGuard) bag.repeatGuard = opts.repeatGuard;
  store.getDaemonControl = (key: string) => (key === 'loop_settings' ? bag : undefined);
  host.env = {
    RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: opts.sameToolStreak ?? '2',
    RAW_AGENT_RECOVERY_ADVISORY_GRACE_BUDGET: '0',
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: opts.failStreak ?? '99',
    RAW_AGENT_RISK_ENGINE: '0',
  };
  host.loopConfig = {
    forceAnswerOnLastTurn: false,
    compactEveryTurn: false,
    spinWatchdog: false,
    hitlLatch: false,
  };
  if (opts.prose) {
    host.runLifecycleHook = async (input) => input.phase === 'stop' ? { block: true } : {};
  }
  host.maxTurnsPerRun = opts.maxTurns ?? 4;
  let shots = 0;
  const adapter: ModelAdapter = {
    name: opts.adapterName,
    ...(opts.modelName ? { modelName: opts.modelName } : {}),
    async runTurn(): Promise<ModelTurnResult> {
      shots += 1;
      opts.onRound?.(shots);
      if (opts.prose) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'same paragraph' }] };
      }
      const text = `${opts.fail ? 'fail' : 'looking'} ${shots}`;
      const parts: MessagePart[] = opts.fail
        ? [
            { type: 'text', text },
            { type: 'tool_call', toolCallId: `bash-${shots}`, name: 'bash', input: { command: 'ls' } },
          ]
        : [
            { type: 'text', text },
            {
              type: 'tool_call',
              toolCallId: `read-${shots}`,
              name: 'read_file',
              input: { path: 'src/app.ts' },
            },
            {
              type: 'tool_call',
              toolCallId: `grep-${shots}`,
              name: 'grep_files',
              input: { pattern: 'repeat' },
            },
          ];
      return { stopReason: 'tool_use', assistantParts: parts };
    },
    async summarizeMessages() {
      return '';
    },
  };
  host.modelAdapter = adapter;
  if (opts.fail) {
    host.executeToolCalls = async (toolCalls) => {
      calls.execute += 1;
      return toolCalls.map((c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        ok: false,
        content: 'boom',
      }));
    };
  }
  await runSessionKernel(host, session.id);
  return {
    waves: calls.execute,
    reason: outcomeOf(store, session.id).reason,
    failureStage: outcomeOf(store, session.id).failureStage,
    system: systemText(store, session.id),
  };
}

describe('repeat guard in the agent loop', () => {
  it('stops a weak model and says it is repeat detection [AC:loop-guard-model-switch#AC-1]', async () => {
    const out = await runRepeated({ adapterName: 'heuristic' });
    expect(out.reason).toBe('repeat_detection');
    expect(out.failureStage).toBe('tool');
    expect(out.system).toMatch(/repeat detection/);
    expect(out.system).toMatch(/read_file/);
    expect(out.system).toMatch(/grep_files/);
    expect(out.waves).toBe(2);
  });

  it('stops a small model name under the default [AC:loop-guard-model-switch#AC-1]', async () => {
    const out = await runRepeated({ adapterName: 'openai-compatible', modelName: 'gpt-4o-mini' });
    expect(out.reason).toBe('repeat_detection');
    expect(out.system).toMatch(/repeat detection/);
    expect(out.waves).toBe(2);
  });

  it('does not stop a strong model that repeats file views [AC:loop-guard-model-switch#AC-2]', async () => {
    const out = await runRepeated({ adapterName: 'openai-compatible', modelName: 'gpt-4o' });
    expect(out.reason).not.toBe('repeat_detection');
    expect(out.system).not.toMatch(/repeat detection/);
    expect(out.waves).toBe(4);
  });

  it('does not stop an unknown model name under the default [AC:loop-guard-model-switch#AC-2]', async () => {
    const out = await runRepeated({ adapterName: 'openai-compatible', modelName: 'my-private-model' });
    expect(out.reason).not.toBe('repeat_detection');
    expect(out.waves).toBe(4);
  });

  it('stops a strong model on the next tool round after saving all [AC:loop-guard-model-switch#AC-3]', async () => {
    const bag: { repeatGuard?: 'weak' | 'all' | 'off' } = {};
    const out = await runRepeated({
      adapterName: 'openai-compatible',
      modelName: 'claude-sonnet-4',
      guardBag: bag,
      onRound: (round) => {
        if (round === 3) bag.repeatGuard = 'all';
      },
    });
    expect(bag.repeatGuard).toBe('all');
    expect(out.reason).toBe('repeat_detection');
    expect(out.system).toMatch(/repeat detection/);
    expect(out.waves).toBe(3);
  });

  it('does not stop a weak model after repeat detection is turned off [AC:loop-guard-model-switch#AC-4]', async () => {
    const out = await runRepeated({ adapterName: 'heuristic', repeatGuard: 'off' });
    expect(out.reason).not.toBe('repeat_detection');
    expect(out.system).not.toMatch(/repeat detection/);
    expect(out.waves).toBe(4);
  });

  it('still stops a weak model that keeps failing the same call when repeat detection is off [AC:tool-loop-same-call#AC-2]', async () => {
    const out = await runRepeated({
      adapterName: 'heuristic',
      repeatGuard: 'off',
      fail: true,
      failStreak: '2',
      sameToolStreak: '99',
    });
    expect(out.reason).toBe('tool_loop');
    expect(out.system).toMatch(/failed/);
    expect(out.system).not.toMatch(/repeat detection/);
    expect(out.waves).toBe(2);
  });

  it('does not stop repeated prose after repeat detection is turned off [AC:tool-loop-same-call#AC-3]', async () => {
    const out = await runRepeated({
      adapterName: 'heuristic',
      repeatGuard: 'off',
      prose: true,
      maxTurns: 4,
    });
    expect(out.reason).toBe('max_turns');
    expect(out.reason).not.toBe('repetition');
    expect(out.system).not.toMatch(/repeated model output/);
  });
});

describe('result-aware risk and recovery wiring', () => {
  async function observe(progress: boolean) {
    const { host, store, session, calls } = createHarness();
    const risks: unknown[] = [];
    store.getDaemonControl = key => key === 'loop_settings' ? { repeatGuard: 'all' } : undefined;
    host.env = { RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3', RAW_AGENT_RECOVERY_ADVISORY_GRACE_BUDGET: '0' };
    host.loopConfig = { forceAnswerOnLastTurn: false, compactEveryTurn: false, spinWatchdog: false, hitlLatch: false };
    host.maxTurnsPerRun = 12;
    host.emitTrace = (_id, event) => { if (event.kind === 'risk_advisory') risks.push(event.data); };
    host.modelAdapter.runTurn = async () => calls.execute === 8
      ? { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] }
      : { stopReason: 'tool_use', assistantParts: [
          { type: 'text', text: 'Checking progress.' },
          { type: 'tool_call', toolCallId: `poll-${calls.execute}`, name: 'read_file', input: { path: 'job.json' } },
        ] };
    host.executeToolCalls = async toolCalls => {
      calls.execute++;
      return toolCalls.map(c => ({ name: c.name, toolCallId: c.toolCallId, ok: true,
        content: JSON.stringify({ completed: progress ? calls.execute : 0, timestamp: calls.execute }) }));
    };
    await runSessionKernel(host, session.id);
    return { waves: calls.execute, risks, reason: outcomeOf(store, session.id).reason };
  }
  it('keeps progressing identical requests running without duplicate risk warnings [AC:tool-progress-guard#AC-1]', async () => {
    const out = await observe(true);
    expect(out.waves).toBe(8);
    expect(out.risks).toEqual([]);
    expect(out.reason).not.toBe('repeat_detection');
  });
  it('shares no-progress detection between warnings and recovery [AC:tool-progress-guard#AC-2]', async () => {
    const out = await observe(false);
    expect(out.waves).toBe(3);
    expect(out.reason).toBe('repeat_detection');
    expect(JSON.stringify(out.risks)).toContain('tool_repeat');
  });
});
