import { describe, expect, it } from 'vitest';
import {
  checkToolApprovals,
  type ToolLoopHost,
} from '../runtime/tool-loop.js';
import type { ApprovalRecord, RunContext, SessionRecord, ToolCallPart, ToolContract } from '../types.js';
import {
  addSessionToolGrant,
  callsNotCoveredBySessionGrant,
  isolationModeOf,
  normalizeSessionToolGrants,
  otherPendingCovered,
  sessionGrantCovers,
} from './session-tool-grant.js';

const ctx = { session: { id: 's1', metadata: {} } } as unknown as RunContext;

function host(overrides: Partial<ToolLoopHost> = {}): ToolLoopHost & { created: string[]; appended: string[] } {
  const created: string[] = [];
  const appended: string[] = [];
  return {
    created,
    appended,
    env: {},
    appendMessage: (_sid, _role, parts) => {
      appended.push(JSON.stringify(parts));
    },
    listApprovals: () => [],
    createApproval: (input) => {
      created.push(`${input.toolName}:${JSON.stringify(input.args)}`);
      return { id: 'ap', status: 'pending', createdAt: '', ...input } as never;
    },
    deleteApproval: () => undefined,
    getTask: () => undefined,
    updateTask: () => undefined,
    emitTrace: () => undefined,
    ...overrides,
  };
}

function tool(name: string): ToolContract<Record<string, unknown>> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'always',
    sideEffectLevel: 'workspace',
    execute: async () => ({ ok: true, content: '' }),
  };
}

const call = (name: string, input: Record<string, unknown>, id = name): ToolCallPart => ({
  type: 'tool_call',
  toolCallId: id,
  name,
  input,
});

function session(metadata: Record<string, unknown>): SessionRecord {
  return { id: 's1', metadata } as SessionRecord;
}

function hash(toolName: string, input: unknown): string {
  const payload = JSON.stringify({ tool: toolName, input });
  let h = 0;
  for (let i = 0; i < payload.length; i++) h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

describe('session tool grants', () => {
  it('treats omitted and auto as one mode, and os, direct, remote as others [AC:console-sections-redesign#AC-2]', () => {
    expect(isolationModeOf('bash', {})).toBe('auto');
    expect(isolationModeOf('bash', { isolation: 'auto' })).toBe('auto');
    expect(isolationModeOf('bash', { isolation: 'strongest' })).toBe('auto');
    expect(isolationModeOf('bg_run', { isolation: 'os' })).toBe('os');
    expect(isolationModeOf('work_evidence', { isolation: 'direct' })).toBe('direct');
    expect(isolationModeOf('bash', { isolation: 'cloudflare-computer' })).toBe('remote');
    expect(isolationModeOf('bash', { isolation: 'docker' })).toBe('container');
    expect(isolationModeOf('write_file', { path: 'a', isolation: 'os' })).toBe('unspecified');
    expect(isolationModeOf('bash', { isolation: 'nope' })).toBe('unknown');
    expect(normalizeSessionToolGrants([{ toolName: '*', isolation: 'os' }, { toolName: 'bash', isolation: 'OS' }, { toolName: 'bash', isolation: 'os' }])).toEqual([
      { toolName: 'bash', isolation: 'os' },
    ]);
  });

  it('skips the same tool and isolation in this session [AC:console-sections-redesign#AC-1]', () => {
    const metadata = { sessionToolGrants: addSessionToolGrant(undefined, 'bash', { command: 'ls', isolation: 'os' }) };
    const h = host();
    const result = checkToolApprovals(
      h,
      [tool('bash'), tool('write_file')],
      [call('bash', { command: 'ls', isolation: 'os' }, 'a'), call('bash', { command: 'pwd', isolation: 'os' }, 'b')],
      ctx,
      undefined,
      session(metadata),
      undefined
    );
    expect(result).toBe('proceed');
    expect(h.created).toEqual([]);
  });

  it('still asks for another tool, another isolation, and a session without the grant [AC:console-sections-redesign#AC-2]', () => {
    const metadata = { sessionToolGrants: [{ toolName: 'bash', isolation: 'os' }] };
    const granted = host();
    const waiting = checkToolApprovals(
      granted,
      [tool('bash'), tool('write_file')],
      [
        call('bash', { command: 'pwd' }, 'auto'),
        call('write_file', { path: 'a.ts' }, 'w'),
      ],
      ctx,
      undefined,
      session(metadata),
      undefined
    );
    expect(waiting).toBe('waiting');
    expect(granted.created.some((row) => row.startsWith('bash:'))).toBe(true);
    expect(granted.created.some((row) => row.startsWith('write_file:'))).toBe(true);
    const directGrant = { sessionToolGrants: [{ toolName: 'bash', isolation: 'direct' }] };
    const card = host();
    const asked = checkToolApprovals(
      card,
      [tool('bash')],
      [call('bash', { command: 'pwd', isolation: 'direct', requestSmartModeApproval: true }, 'card')],
      ctx,
      undefined,
      session(metadata),
      undefined
    );
    expect(asked).toBe('waiting');
    expect(card.created.length).toBe(1);
    const skipped = host();
    expect(checkToolApprovals(
      skipped,
      [tool('bash')],
      [call('bash', { command: 'pwd', isolation: 'direct', requestSmartModeApproval: true }, 'skip')],
      ctx,
      undefined,
      session(directGrant),
      undefined
    )).toBe('proceed');
    expect(skipped.created).toEqual([]);
    const other = host();
    expect(checkToolApprovals(other, [tool('bash')], [call('bash', { command: 'ls', isolation: 'os' })], ctx, undefined, session({}), undefined)).toBe('waiting');
    expect(other.created).toHaveLength(1);
    expect(callsNotCoveredBySessionGrant(
      [{ name: 'bash', input: { isolation: 'direct' } }, { name: 'bash', input: { isolation: 'os' } }],
      metadata
    ).map((item) => item.input)).toEqual([{ isolation: 'direct' }]);
  });

  it('keeps an exact rejection and asks again after revoke [AC:console-sections-redesign#AC-2] [AC:console-sections-redesign#AC-3]', () => {
    const input = { command: 'ls', isolation: 'os' };
    const metadata = { sessionToolGrants: [{ toolName: 'bash', isolation: 'os' }, { toolName: 'write_file', isolation: 'unspecified' }] };
    expect(sessionGrantCovers(metadata, 'bash', input, 'rejected')).toBe(false);
    const denied = host({
      listApprovals: () => [{
        id: 'old',
        sessionId: 's1',
        toolName: 'bash',
        status: 'rejected',
        reason: 'no',
        args: input,
        idempotencyKey: hash('bash', input),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as ApprovalRecord],
    });
    const deniedResult = checkToolApprovals(denied, [tool('bash')], [call('bash', input)], ctx, undefined, session(metadata), undefined);
    expect(deniedResult).not.toBe('waiting');
    expect(denied.appended.join('')).toContain('was rejected');
    expect(denied.created).toEqual([]);
    const revoked = { sessionToolGrants: normalizeSessionToolGrants([{ toolName: 'write_file', isolation: 'unspecified' }]) };
    const again = host();
    expect(checkToolApprovals(again, [tool('bash')], [call('bash', input, 'next')], ctx, undefined, session(revoked), undefined)).toBe('waiting');
    expect(again.created).toHaveLength(1);
    expect(sessionGrantCovers(revoked, 'write_file', { path: 'a' })).toBe(true);
  });

  it('covers other pending calls of the same kind only [AC:console-sections-redesign#AC-1] [AC:console-sections-redesign#AC-2]', () => {
    const items = [
      { id: 'self', sessionId: 's1', toolName: 'bash', args: { isolation: 'os' }, status: 'pending' },
      { id: 'same', sessionId: 's1', toolName: 'bash', args: { command: 'pwd', isolation: 'os' }, status: 'pending' },
      { id: 'direct', sessionId: 's1', toolName: 'bash', args: { isolation: 'direct' }, status: 'pending' },
      { id: 'else', sessionId: 's2', toolName: 'bash', args: { isolation: 'os' }, status: 'pending' },
    ];
    expect(otherPendingCovered(items, 'self', 's1', 'bash', { isolation: 'os' })).toEqual(['same']);
  });
});
