import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PTC_TIMEOUT_MS,
  MIN_PTC_TIMEOUT_MS,
  PtcIsolateError,
  clampPtcTimeoutMs,
  runPtcCell,
  wrapPtcCellSource,
} from './isolate.js';
import { PTC_NAMESPACE_BLOCKED_NAMES, buildPtcNamespace, isPtcNamespaceTool } from './hooks.js';
import {
  PTC_SCRATCH_MAX_VALUE_CHARS,
  PtcScratchpadError,
  PtcScratchpadSession,
  createMemoryScratchPersist,
  parseScratchpadWrite,
} from './scratchpad.js';
import type { RunContext, ToolContract } from '../types.js';

function tool(
  name: string,
  extra: Partial<ToolContract<Record<string, unknown>>> = {}
): ToolContract<Record<string, unknown>> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async (_c, args) => ({ ok: true, content: JSON.stringify(args) }),
    ...extra,
  };
}

describe('isolate: source wrapping and timeouts', () => {
  it('turns a trailing expression into a return and leaves statements alone', () => {
    expect(wrapPtcCellSource('const a = 1;\na + 1')).toContain('return (a + 1);');
    expect(wrapPtcCellSource('return 5')).not.toContain('return (return');
    expect(wrapPtcCellSource('if (x) {\n  y();\n}')).not.toContain('return (');
    expect(() => wrapPtcCellSource('   ')).toThrow(PtcIsolateError);
    expect(() => wrapPtcCellSource('x'.repeat(60_001))).toThrow(/exceeds/);
  });

  it('clamps timeouts into [MIN, DEFAULT]', () => {
    expect(clampPtcTimeoutMs()).toBe(DEFAULT_PTC_TIMEOUT_MS);
    expect(clampPtcTimeoutMs(Number.NaN)).toBe(DEFAULT_PTC_TIMEOUT_MS);
    expect(clampPtcTimeoutMs(1)).toBe(MIN_PTC_TIMEOUT_MS);
    expect(clampPtcTimeoutMs(10 ** 9)).toBe(DEFAULT_PTC_TIMEOUT_MS);
    expect(clampPtcTimeoutMs(250.9)).toBe(250);
  });
});

describe('isolate: runPtcCell sandbox', () => {
  it('runs code against injected hooks, awaits async results and captures console', async () => {
    const out = await runPtcCell(
      `
      const a = await double(21);
      console.log('got', a, { nested: true });
      a + (await tools.inc(1))
      `,
      { hooks: { double: async (n: unknown) => Number(n) * 2, tools: { inc: (n: unknown) => Number(n) + 1 } } }
    );
    expect(out.value).toBe(44);
    expect(out.logs).toEqual(['got 42 {"nested":true}']);
  });

  it('forbids host escape hatches and dynamic import', async () => {
    for (const code of ['process.env', 'require("fs")', 'fetch("https://x")', 'eval("1")', 'new Function("return 1")()']) {
      await expect(runPtcCell(code, { hooks: {} })).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(runPtcCell('await import("node:fs")', { hooks: {} })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('classifies runtime errors and honors an aborted controller', async () => {
    const err = await runPtcCell('throw new Error("boom")', { hooks: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PtcIsolateError);
    expect((err as PtcIsolateError).code).toBe('runtime');
    expect((err as PtcIsolateError).message).toMatch(/boom/);
    const ac = new AbortController();
    ac.abort();
    await expect(runPtcCell('1', { hooks: {}, abortController: ac })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('times out a never-resolving hook', async () => {
    await expect(
      runPtcCell('await hang()', { hooks: { hang: () => new Promise(() => undefined) }, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('does not leak hook function internals (constructor / prototype)', async () => {
    await expect(runPtcCell('double.constructor', { hooks: { double: (n: unknown) => n } })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('hooks: namespace construction', () => {
  const ctx = {} as RunContext;
  const noop = async () => undefined;
  const scratchpad = { write: noop, read: noop, list: noop, delete: noop };

  it('only exposes read-classified, non-confirm, non-blocked tools', () => {
    expect(isPtcNamespaceTool(tool('web_search', { ptc: { kind: 'read' } }))).toBe(true);
    expect(isPtcNamespaceTool(tool('web_search', { ptc: { kind: 'read', requiresConfirm: true } }))).toBe(false);
    expect(isPtcNamespaceTool(tool('edit_file', { ptc: { kind: 'write' } }))).toBe(false);
    expect(isPtcNamespaceTool(tool('unmarked'))).toBe(false);
    expect(isPtcNamespaceTool(tool('bash', { ptc: { kind: 'read' } }))).toBe(false);
    expect(PTC_NAMESPACE_BLOCKED_NAMES.has('bash')).toBe(true);
  });

  it('binds tools by name (and under tools.*), skipping reserved identifiers and normalizing shorthand args', async () => {
    const seen: string[] = [];
    const ns = buildPtcNamespace({
      context: ctx,
      authorizedTools: [
        tool('web_search', { ptc: { kind: 'read' } }),
        tool('Math', { ptc: { kind: 'read' } }),
        tool('write_file', { ptc: { kind: 'write' } }),
      ],
      agent: noop,
      scratchpad,
      verify: noop,
      onToolCall: (name) => {
        seen.push(name);
      },
    });
    expect(ns.toolNames).toEqual(['Math', 'web_search']);
    expect(typeof ns.bindings.web_search).toBe('function');
    expect(ns.bindings.Math).toBeUndefined();
    expect(typeof (ns.bindings.tools as Record<string, unknown>).Math).toBe('function');
    expect(ns.bindings.write_file).toBeUndefined();

    const search = ns.bindings.web_search as (raw?: unknown) => Promise<{ content: string }>;
    expect(JSON.parse((await search('cats')).content)).toEqual({ query: 'cats' });
    expect(JSON.parse((await search()).content)).toEqual({});
    await expect(search([1])).rejects.toThrow(/expects an object/);
    expect(seen).toEqual(['web_search', 'web_search']);
  });

  it('refuses read-tool calls that need approval instead of bypassing it', async () => {
    let executed = 0;
    const gated = {
      ...tool('read_file', { ptc: { kind: 'read' } }),
      approvalMode: 'auto' as const,
      needsApproval: (_c: RunContext, args: Record<string, unknown>) => Boolean(args.machineId),
      execute: async () => {
        executed += 1;
        return { ok: true, content: 'read' };
      },
    };
    const ns = buildPtcNamespace({ context: ctx, authorizedTools: [gated], agent: noop, scratchpad, verify: noop });
    const read = ns.bindings.read_file as (raw?: unknown) => Promise<{ ok: boolean; content: string }>;
    const blocked = await read({ path: 'x', machineId: 'desk' });
    expect(blocked.ok).toBe(false);
    expect(blocked.content).toContain('approval_required');
    expect((await read({ path: 'x' })).ok).toBe(true);
    expect(executed).toBe(1);
  });

  it('refuses tool calls once the run is aborted', async () => {
    const ac = new AbortController();
    const ns = buildPtcNamespace({
      context: { abortSignal: ac.signal } as RunContext,
      authorizedTools: [tool('web_search', { ptc: { kind: 'read' } })],
      agent: noop,
      scratchpad,
      verify: noop,
    });
    ac.abort();
    await expect((ns.bindings.web_search as () => Promise<unknown>)()).rejects.toThrow(/aborted/);
  });

  it('omits jev unless host provides hooks; injects noul/choice when present', async () => {
    const without = buildPtcNamespace({
      context: ctx,
      authorizedTools: [],
      agent: noop,
      scratchpad,
      verify: noop,
    });
    expect(without.bindings.jev).toBeUndefined();

    const withJev = buildPtcNamespace({
      context: ctx,
      authorizedTools: [],
      agent: noop,
      scratchpad,
      verify: noop,
      jev: {
        noul: async () => ({ value: true, p: 0.9 }),
        choice: async () => ({ value: 'a', p: 0.8 }),
      },
    });
    const jev = withJev.bindings.jev as {
      noul: () => Promise<{ value: boolean; p: number }>;
      choice: () => Promise<{ value: string; p: number }>;
    };
    expect(await jev.noul()).toEqual({ value: true, p: 0.9 });
    expect(await jev.choice()).toEqual({ value: 'a', p: 0.8 });
  });
});

describe('scratchpad', () => {
  it('parses string and object write specs', () => {
    expect(parseScratchpadWrite('k', { a: 1 })).toEqual({ key: 'k', value: '{"a":1}', visibility: 'session', pin: false });
    expect(parseScratchpadWrite({ key: ' k ', value: 'v', visibility: 'cell', pin: true, ttlSec: 5 })).toEqual({
      key: 'k',
      value: 'v',
      visibility: 'cell',
      pin: true,
      ttlSec: 5,
    });
    expect(parseScratchpadWrite({ key: 'k', content: 'c', visibility: 'bogus' }).visibility).toBe('session');
    expect(() => parseScratchpadWrite('')).toThrow(PtcScratchpadError);
    expect(() => parseScratchpadWrite({ value: 1 })).toThrow(/requires key/);
  });

  it('round-trips writes through the persist layer, lists, deletes and enforces limits', async () => {
    const pad = new PtcScratchpadSession(createMemoryScratchPersist());
    const w = await pad.write('notes', { step: 1 });
    expect(w).toMatchObject({ ok: true, key: 'notes', visibility: 'session' });
    expect((await pad.read('notes')).content).toBe('{"step":1}');
    expect((await pad.list()).entries.map((e) => e.key)).toEqual(['notes']);
    await pad.delete('notes');
    await expect(pad.read('notes')).rejects.toMatchObject({ code: 'not_found' });
    await expect(pad.write('big', 'x'.repeat(PTC_SCRATCH_MAX_VALUE_CHARS + 1))).rejects.toMatchObject({ code: 'too_large' });
    await expect(pad.write('__last_return', 'x')).rejects.toMatchObject({ code: 'reserved' });
  });

  it('cell-visibility entries stay in memory and expire via ttl', async () => {
    let now = 1_000_000;
    const persist = createMemoryScratchPersist();
    const pad = new PtcScratchpadSession(persist, () => now);
    await pad.write({ key: 'tmp', value: 'v', visibility: 'cell', ttlSec: 1 });
    expect(await persist.count()).toBe(0);
    expect((await pad.read('tmp')).content).toBe('v');
    now += 2_000;
    await expect(pad.read('tmp')).rejects.toMatchObject({ code: 'not_found' });
  });
});
