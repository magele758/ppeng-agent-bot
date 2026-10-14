import { describe, expect, it, vi } from 'vitest';
import {
  checkToolApprovals,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  envToolResultMaxChars,
  executeSingleTool,
  executeToolCalls,
  filterValidToolCalls,
  truncateToolContent,
  type CompletedWaveItem,
  type ToolLoopHost,
} from './tool-loop.js';
import type { RunContext, SessionRecord, ToolCallPart, ToolContract } from '../types.js';

const ctx = { session: { id: 's1', metadata: {} } } as unknown as RunContext;

function host(overrides: Partial<ToolLoopHost> = {}): ToolLoopHost & { appended: unknown[]; traces: string[] } {
  const appended: unknown[] = [];
  const traces: string[] = [];
  return {
    appended,
    traces,
    env: {},
    appendMessage: (_sid, role, parts) => {
      appended.push({ role, parts });
    },
    listApprovals: () => [],
    createApproval: (input) =>
      ({ id: 'ap', status: 'pending', createdAt: '', ...input }) as never,
    deleteApproval: () => undefined,
    getTask: () => undefined,
    updateTask: () => undefined,
    emitTrace: (_sid, ev) => {
      traces.push(ev.kind);
    },
    ...overrides,
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

const call = (name: string, input: Record<string, unknown>, id = `tc-${name}`): ToolCallPart => ({
  type: 'tool_call',
  toolCallId: id,
  name,
  input,
});

describe('tool result truncation knobs', () => {
  it('defaults to 120k and honors both env keys (legacy RAW_AGENT_* wins)', () => {
    expect(envToolResultMaxChars({})).toBe(DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(120_000);
    expect(envToolResultMaxChars({ TOOL_RESULT_MAX_CHARS: '500' })).toBe(500);
    expect(envToolResultMaxChars({ RAW_AGENT_TOOL_RESULT_MAX_CHARS: '900' })).toBe(900);
    expect(
      envToolResultMaxChars({ RAW_AGENT_TOOL_RESULT_MAX_CHARS: '900', TOOL_RESULT_MAX_CHARS: '500' })
    ).toBe(900);
    expect(envToolResultMaxChars({ RAW_AGENT_TOOL_RESULT_MAX_CHARS: 'abc' })).toBe(120_000);
    expect(envToolResultMaxChars({ RAW_AGENT_TOOL_RESULT_MAX_CHARS: '0' })).toBe(120_000);
    expect(envToolResultMaxChars({ RAW_AGENT_TOOL_RESULT_MAX_CHARS: '99.7' })).toBe(99);
  });

  it('keeps head and tail when truncating', () => {
    expect(truncateToolContent('short', 100)).toBe('short');
    const out = truncateToolContent('a'.repeat(50) + 'b'.repeat(50), 20);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out.endsWith('b'.repeat(10))).toBe(true);
    expect(out).toContain('80 chars truncated');
  });
});

describe('executeSingleTool', () => {
  it('returns a structured unknown_tool result with did_you_mean', async () => {
    const h = host();
    const r = await executeSingleTool(h, [tool('read_file', async () => ({ ok: true, content: '' }))], call('read_fil', {}), ctx, false, 's1');
    expect(r.ok).toBe(false);
    expect(r.problem?.code).toBe('UNKNOWN_TOOL');
    const payload = JSON.parse(r.content) as { did_you_mean?: string; error_code: string };
    expect(payload.error_code).toBe('UNKNOWN_TOOL');
    expect(payload.did_you_mean).toBe('read_file');
  });

  it('gates dirty {raw} arguments unless disabled', async () => {
    const t = tool('echo', async (_c, args) => ({ ok: true, content: JSON.stringify(args) }));
    const gated = await executeSingleTool(host(), [t], call('echo', { raw: '{bad' }), ctx, false, 's1');
    expect(gated.ok).toBe(false);
    expect(gated.problem?.code).toBe('DIRTY_TOOL_ARGS_RAW');
    const passed = await executeSingleTool(host({ gateDirtyInput: false }), [t], call('echo', { raw: '{bad' }), ctx, false, 's1');
    expect(passed.ok).toBe(true);
  });

  it('blocks external AI tools unless allowed', async () => {
    const t = tool('claude_code', async () => ({ ok: true, content: 'x' }), { isExternal: true });
    const blocked = await executeSingleTool(host(), [t], call('claude_code', {}), ctx, false, 's1');
    expect(blocked.problem?.code).toBe('TOOL_DISABLED_IN_SESSION');
    const allowed = await executeSingleTool(host(), [t], call('claude_code', {}), ctx, true, 's1');
    expect(allowed.ok).toBe(true);
    expect(allowed.isExternal).toBe(true);
  });

  it('truncates using the env threshold and exports a span on success and on throw', async () => {
    const spans: Array<{ toolName: string; ok: boolean }> = [];
    const h = host({
      env: { RAW_AGENT_TOOL_RESULT_MAX_CHARS: '40' },
      exportToolSpan: ({ toolName, ok, durationMs }) => {
        expect(durationMs).toBeGreaterThanOrEqual(0);
        spans.push({ toolName, ok });
      },
    });
    const big = tool('big', async () => ({ ok: true, content: 'x'.repeat(1000) }));
    const boom = tool('boom', async () => {
      throw new Error('kaboom');
    });
    const r1 = await executeSingleTool(h, [big, boom], call('big', {}), ctx, false, 's1');
    expect(r1.content.length).toBeLessThan(120);
    expect(r1.content).toContain('chars truncated');
    const r2 = await executeSingleTool(h, [big, boom], call('boom', {}), ctx, false, 's1');
    expect(r2.ok).toBe(false);
    expect(r2.content).toBe('kaboom');
    expect(r2.problem?.code).toBe('TOOL_UNHANDLED_EXCEPTION');
    expect(spans).toEqual([
      { toolName: 'big', ok: true },
      { toolName: 'boom', ok: false },
    ]);
    expect(h.traces).toContain('tool_start');
  });

  it('a throwing exportToolSpan never fails the tool', async () => {
    const h = host({
      exportToolSpan: () => {
        throw new Error('otel down');
      },
    });
    const r = await executeSingleTool(h, [tool('ok', async () => ({ ok: true, content: 'fine' }))], call('ok', {}), ctx, false, 's1');
    expect(r).toMatchObject({ ok: true, content: 'fine' });
  });

  it('honors pre_tool_use block / input rewrite and runs post_tool_use', async () => {
    const phases: string[] = [];
    const h = host({
      runLifecycleHook: async (input) => {
        phases.push(input.phase);
        if (input.phase === 'pre_tool_use') {
          if (input.tool === 'deny') return { permissionDecision: 'block', message: 'nope' };
          return { input: { rewritten: true } };
        }
        return {};
      },
    });
    const echo = tool('echo', async (_c, args) => ({ ok: true, content: JSON.stringify(args) }));
    const deny = tool('deny', async () => ({ ok: true, content: 'should not run' }));
    const r1 = await executeSingleTool(h, [echo, deny], call('echo', { a: 1 }), ctx, false, 's1');
    expect(JSON.parse(r1.content)).toEqual({ rewritten: true });
    const r2 = await executeSingleTool(h, [echo, deny], call('deny', {}), ctx, false, 's1');
    expect(r2.ok).toBe(false);
    expect(r2.problem?.code).toBe('PRE_TOOL_USE_BLOCKED');
    expect(phases).toEqual(['pre_tool_use', 'post_tool_use', 'pre_tool_use']);
  });

  it('redacts non-shell tool output', async () => {
    const h = host({
      redactSecrets: (s) => s.replace(/sk-\w+/g, '[redacted]'),
    });
    const read = tool('read_file', async () => ({ ok: true, content: 'file sk-abc123 tail' }));
    const r = await executeSingleTool(h, [read], call('read_file', { path: 'a.txt' }), ctx, false, 's1');
    expect(r.content).toBe('file [redacted] tail');
    expect(r.content).not.toContain('sk-abc123');
  });

  it('redacts shell-like output and prefers archived content over truncation', async () => {
    const h = host({
      env: { TOOL_RESULT_MAX_CHARS: '10' },
      redactSecrets: (s) => s.replace(/sk-\w+/g, '[redacted]'),
      archiveToolResult: ({ content }) => (content.length > 10 ? `archived:${content.length}` : content),
    });
    const bash = tool('bash', async () => ({ ok: true, content: 'token sk-abc123 leaked here' }));
    const r = await executeSingleTool(h, [bash], call('bash', { command: 'env' }), ctx, false, 's1');
    expect(r.content).toMatch(/^archived:/);
    expect(r.content).not.toContain('sk-abc123');
  });
});

describe('executeToolCalls', () => {
  it('runs in waves of maxParallel and compensates completed items when any result fails', async () => {
    const running: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const slow = (name: string, ok = true) =>
      tool(name, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        running.push(concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return { ok, content: name };
      });
    const compensate = vi.fn(async (_items: CompletedWaveItem[]) => undefined);
    const h = host({ compensate });
    const tools = [slow('a'), slow('b'), slow('c'), slow('d', false)];
    const results = await executeToolCalls(
      h,
      tools,
      [call('a', {}), call('b', {}), call('c', {}), call('d', {})],
      ctx,
      false,
      's1',
      2
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(compensate).toHaveBeenCalledTimes(1);
    const items = compensate.mock.calls[0]![0];
    expect(items.map((i) => i.toolCallId)).toEqual(['tc-a', 'tc-b', 'tc-c', 'tc-d']);
  });

  it('marks a rolled-back success as a failure', async () => {
    const h = host({
      compensate: async (items) => ({
        compensated: items.filter((item) => item.tool.name === 'write_file').map((item) => item.toolCallId),
      }),
    });
    const results = await executeToolCalls(
      h,
      [
        tool('write_file', async () => ({ ok: true, content: 'wrote' })),
        tool('bash', async () => ({ ok: false, content: 'boom' })),
      ],
      [call('write_file', { path: 'a.txt' }), call('bash', { command: 'false' })],
      ctx,
      false,
      's1',
      4
    );
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.content).toContain('Rolled back');
    expect(results[1]?.ok).toBe(false);
  });

  it('does not compensate when every result is ok', async () => {
    const compensate = vi.fn(async () => undefined);
    const h = host({ compensate });
    await executeToolCalls(h, [tool('a', async () => ({ ok: true, content: '' }))], [call('a', {})], ctx, false, 's1', 4);
    expect(compensate).not.toHaveBeenCalled();
  });
});

describe('filterValidToolCalls', () => {
  it('drops external tool calls when not allowed and writes a 403 problem tool_result', () => {
    const h = host();
    const ext = tool('codex_exec', async () => ({ ok: true, content: '' }), { isExternal: true });
    const plain = tool('ls', async () => ({ ok: true, content: '' }));
    const kept = filterValidToolCalls(h, [ext, plain], [call('codex_exec', {}), call('ls', {})], false, 's1');
    expect(kept.map((c) => c.name)).toEqual(['ls']);
    expect(h.appended).toHaveLength(1);
    const first = h.appended[0] as { role: string; parts: Array<{ type: string; ok?: boolean }> };
    expect(first.role).toBe('tool');
    expect(first.parts[0]).toMatchObject({ type: 'tool_result', ok: false });
  });
});

describe('checkToolApprovals', () => {
  const session = { id: 's1', metadata: {} } as unknown as SessionRecord;
  const always = (name: string) =>
    tool(name, async () => ({ ok: true, content: '' }), { approvalMode: 'always' });

  it('creates one pending approval per call and does not proceed when only one is approved', () => {
    const approvals: Array<{
      id: string;
      sessionId: string;
      toolName: string;
      status: 'pending' | 'approved' | 'rejected';
      idempotencyKey?: string;
    }> = [];
    const h = host({
      listApprovals: (filter) =>
        approvals.filter((approval) => !filter?.status || approval.status === filter.status) as never,
      createApproval: (input) => {
        const row = {
          id: `ap-${approvals.length + 1}`,
          sessionId: input.sessionId,
          toolName: input.toolName,
          status: 'pending' as const,
          idempotencyKey: input.idempotencyKey,
        };
        approvals.push(row);
        return row as never;
      },
    });
    const calls = [call('bash', { command: 'ls' }, 'c1'), call('write_file', { path: 'a.txt' }, 'c2')];
    const tools = [always('bash'), always('write_file')];
    expect(checkToolApprovals(h, tools, calls, ctx, undefined, session, undefined)).toBe('waiting');
    expect(approvals.map((approval) => approval.toolName)).toEqual(['bash', 'write_file']);

    approvals[0]!.status = 'approved';
    expect(checkToolApprovals(h, tools, calls, ctx, undefined, session, undefined)).toBe('waiting');
    expect(approvals).toHaveLength(2);
  });

  it('records a rejection and proceeds only for calls that are already approved', () => {
    const approvals: Array<{
      id: string;
      sessionId: string;
      toolName: string;
      status: 'pending' | 'approved' | 'rejected';
      idempotencyKey?: string;
    }> = [];
    let lists = 0;
    const h = host({
      listApprovals: (filter) => {
        lists += 1;
        return approvals.filter((approval) => !filter?.status || approval.status === filter.status) as never;
      },
      createApproval: (input) => {
        const row = {
          id: `ap-${approvals.length + 1}`,
          sessionId: input.sessionId,
          toolName: input.toolName,
          status: 'pending' as const,
          idempotencyKey: input.idempotencyKey,
        };
        approvals.push(row);
        return row as never;
      },
    });
    const calls = [call('bash', { command: 'ls' }, 'c1'), call('write_file', { path: 'a.txt' }, 'c2')];
    const tools = [always('bash'), always('write_file')];
    const opened = { reported: false, ids: [] as string[] };
    checkToolApprovals(h, tools, calls, ctx, undefined, session, undefined, opened);
    expect(lists).toBe(1);
    expect(opened).toEqual({ reported: true, ids: [] });
    approvals[0]!.status = 'approved';
    approvals[1]!.status = 'rejected';
    const closed = { reported: false, ids: [] as string[] };
    lists = 0;
    expect(checkToolApprovals(h, tools, calls, ctx, undefined, session, undefined, closed)).toBe('proceed');
    expect(lists).toBe(1);
    expect(closed).toEqual({ reported: true, ids: ['c2'] });
    expect(approvals).toHaveLength(2);
    const parts = h.appended.flatMap((entry) => (entry as { parts: Array<{ toolCallId?: string; ok?: boolean; content?: string }> }).parts);
    expect(parts).toEqual([
      expect.objectContaining({
        toolCallId: 'c2',
        ok: false,
        content: 'Approval for write_file was rejected.',
      }),
    ]);
  });

  it('reuses the approval key for ask-mode tools whose approvalMode is never', () => {
    const approvals: Array<{
      id: string;
      sessionId: string;
      toolName: string;
      status: 'pending' | 'approved' | 'rejected';
      idempotencyKey?: string;
    }> = [];
    const h = host({
      listApprovals: (filter) =>
        approvals.filter((approval) => !filter?.status || approval.status === filter.status) as never,
      createApproval: (input) => {
        const row = {
          id: `ap-${approvals.length + 1}`,
          sessionId: input.sessionId,
          toolName: input.toolName,
          status: 'pending' as const,
          idempotencyKey: input.idempotencyKey,
        };
        approvals.push(row);
        return row as never;
      },
    });
    const ask = { id: 's1', metadata: { permissionMode: 'ask' } } as unknown as SessionRecord;
    const spill = tool('spill_tool_result', async () => ({ ok: true, content: 'spilled' }), {
      approvalMode: 'never',
    });
    const calls = [call('spill_tool_result', { uri: 'tool-result://1' }, 'spill-1')];
    expect(checkToolApprovals(h, [spill], calls, ctx, undefined, ask, undefined)).toBe('waiting');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.idempotencyKey).toBeTruthy();

    approvals[0]!.status = 'approved';
    const closed = { reported: false, ids: [] as string[] };
    expect(checkToolApprovals(h, [spill], calls, ctx, undefined, ask, undefined, closed)).toBe('proceed');
    expect(closed).toEqual({ reported: true, ids: [] });
    expect(approvals).toHaveLength(1);
    expect(h.appended).toHaveLength(0);
  });

  it('writes a result for every call when plan mode blocks one of them', () => {
    const h = host();
    const plan = { id: 's1', metadata: { permissionMode: 'plan' } } as unknown as SessionRecord;
    const tools = [
      tool('read_file', async () => ({ ok: true, content: 'file' }), { approvalMode: 'never' }),
      tool('bash', async () => ({ ok: true, content: 'ran' }), { approvalMode: 'always' }),
    ];
    const decision = checkToolApprovals(
      h,
      tools,
      [call('read_file', { path: 'a.txt' }, 'read-1'), call('bash', { command: 'rm -rf /' }, 'bash-1')],
      ctx,
      undefined,
      plan,
      undefined
    );
    expect(decision).toBe('skip');
    const parts = h.appended.flatMap(
      (entry) => (entry as { parts: Array<{ toolCallId?: string; content?: string }> }).parts
    );
    expect(parts.map((part) => part.toolCallId).sort()).toEqual(['bash-1', 'read-1']);
    expect(parts.find((part) => part.toolCallId === 'read-1')?.content).not.toContain('tool_result_missing');
  });
});

describe('multimodal tool observations', () => {
  it('keeps screenshots after every paired tool result [AC:lcu-computer-use#AC-3]', async () => {
    const h = host();
    const image = { type: 'image' as const, assetId: 'screenshot', mimeType: 'image/png' };
    const r = await executeSingleTool(h, [tool('desktop', async () => ({ ok: true, content: 'observed', images: [image] }))], call('desktop', {}, 'image-call'), ctx, false, 's1');
    expect(r.images).toEqual([image]);
    const { processToolResults } = await import('./tool-loop.js');
    processToolResults(h, [r, { toolCallId: 'other-call', name: 'other', ok: true, content: 'done' }], [], ctx.session, undefined, 's1');
    expect(h.appended.map((m: any) => m.role)).toEqual(['tool','tool','user']);
    expect((h.appended[2] as any).parts).toContainEqual(image);
  });
});
