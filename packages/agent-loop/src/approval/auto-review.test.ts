import { describe, expect, it } from 'vitest';
import {
  autoReviewIdempotencyKey,
  evaluateAutoReview,
  hasRequestSmartModeApproval,
  isHighRiskAutoReviewCall,
  normalizeAuthorizedBy,
  readAuthorizedBy,
  stripAutoReviewFlags,
} from './auto-review.js';
import {
  checkToolApprovals,
  type ToolLoopHost,
} from '../runtime/tool-loop.js';
import type { ApprovalRecord, RunContext, SessionRecord, ToolCallPart, ToolContract } from '../types.js';

const ctx = { session: { id: 's1', metadata: {} } } as unknown as RunContext;

function host(overrides: Partial<ToolLoopHost> = {}): ToolLoopHost & {
  appended: unknown[];
  approvals: ApprovalRecord[];
} {
  const appended: unknown[] = [];
  const approvals: ApprovalRecord[] = [];
  return {
    appended,
    approvals,
    env: {},
    appendMessage: (_sid, role, parts) => {
      appended.push({ role, parts });
    },
    listApprovals: () => approvals,
    createApproval: (input) => {
      const pending = approvals.find(
        (row) =>
          row.status === 'pending' &&
          row.sessionId === input.sessionId &&
          Boolean(row.idempotencyKey) &&
          row.idempotencyKey === input.idempotencyKey
      );
      if (pending) {
        if (input.authorizedBy?.length && !pending.authorizedBy?.length) pending.authorizedBy = [...input.authorizedBy];
        return pending;
      }
      const row = {
        id: `ap-${approvals.length + 1}`,
        sessionId: input.sessionId,
        toolName: input.toolName,
        status: 'pending' as const,
        reason: input.reason,
        args: input.args ?? {},
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(input.authorizedBy?.length ? { authorizedBy: [...input.authorizedBy] } : {}),
      } as ApprovalRecord;
      approvals.push(row);
      return row;
    },
    deleteApproval: () => undefined,
    getTask: () => undefined,
    updateTask: () => undefined,
    emitTrace: () => undefined,
    ...overrides,
  };
}

function tool(
  name: string,
  extra: Partial<ToolContract<Record<string, unknown>>> = {}
): ToolContract<Record<string, unknown>> {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => false,
    execute: async () => ({ ok: true, content: 'ran' }),
    ...extra,
  };
}

const call = (name: string, input: Record<string, unknown>, id = `tc-${name}`): ToolCallPart => ({
  type: 'tool_call',
  toolCallId: id,
  name,
  input,
});

describe('auto-review classifier', () => {
  it('treats risky shell and MCP as high-risk, strips approval flags from fingerprint', () => {
    expect(isHighRiskAutoReviewCall('bash', { command: 'rm -rf /tmp/x' })).toBe(true);
    expect(isHighRiskAutoReviewCall('bash', { command: 'ls' })).toBe(false);
    expect(isHighRiskAutoReviewCall('mcp_invoke', { server: 0, tool: 'x' })).toBe(true);
    expect(hasRequestSmartModeApproval({ requestSmartModeApproval: true })).toBe(true);
    expect(stripAutoReviewFlags({
      command: 'rm -rf x',
      requestSmartModeApproval: true,
      smartModeBlockReason: 'prior',
      authorizedBy: ['tNu1'],
      authorized_by: ['tNsM2'],
    })).toEqual({
      command: 'rm -rf x',
    });
    const key = autoReviewIdempotencyKey('bash', { command: 'rm -rf x' }, (n, i) => `${n}:${JSON.stringify(i)}`);
    expect(key.startsWith('ar:')).toBe(true);
  });
});

describe('checkToolApprovals Auto-review gate', () => {
  const session = { id: 's1', metadata: {} } as unknown as SessionRecord;
  const risky = call('bash', { command: 'rm -rf ./build' }, 'c-risk');
  const tools = [tool('bash'), tool('mcp_invoke', { needsApproval: () => true, sideEffectLevel: 'system' })];

  it('soft-blocks high-risk shell by default without a card [AC:auto-review-shell-mcp#AC-1]', () => {
    const h = host();
    expect(checkToolApprovals(h, tools, [risky], ctx, undefined, session, undefined)).toBe('skip');
    expect(h.approvals).toHaveLength(0);
    const parts = h.appended.flatMap((e) => (e as { parts: Array<{ problem?: { code?: string }; content?: string }> }).parts);
    expect(parts[0]?.problem?.code).toBe('AUTO_REVIEW_BLOCKED');
    expect(parts[0]?.content).toMatch(/requestSmartModeApproval/);
  });

  it('shows a native approval card on same-action retry with the flag [AC:auto-review-shell-mcp#AC-2]', () => {
    const h = host();
    const flagged = call(
      'bash',
      {
        command: 'rm -rf ./build',
        requestSmartModeApproval: true,
        smartModeBlockReason: 'Auto-review blocked high-risk bash',
      },
      'c-flag'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.status).toBe('pending');
    expect(h.approvals[0]?.idempotencyKey?.startsWith('ar:')).toBe(true);
    expect(h.approvals[0]?.reason).toMatch(/Auto-review/);
    // fingerprint args must not carry the escalate flags
    expect(h.approvals[0]?.args).toEqual({ command: 'rm -rf ./build' });
  });

  it('proceeds on same params after approve, with or without the flag [AC:auto-review-shell-mcp#AC-3]', () => {
    const h = host();
    const flagged = call('bash', { command: 'rm -rf ./build', requestSmartModeApproval: true }, 'c1');
    checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined);
    h.approvals[0]!.status = 'approved';
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('proceed');
    expect(h.approvals).toHaveLength(1);
    const again = call('bash', { command: 'rm -rf ./build' }, 'c2');
    expect(checkToolApprovals(h, tools, [again], ctx, undefined, session, undefined)).toBe('proceed');
    expect(h.approvals).toHaveLength(1);
  });

  it('treats denial as terminal and does not open a new card [AC:auto-review-shell-mcp#AC-4]', () => {
    const h = host();
    const flagged = call('bash', { command: 'sudo apt install x', requestSmartModeApproval: true }, 'c1');
    checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined);
    h.approvals[0]!.status = 'rejected';
    const closed = { reported: false, ids: [] as string[] };
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined, closed)).toBe('skip');
    expect(closed.ids).toEqual(['c1']);
    expect(h.approvals).toHaveLength(1);
    const parts = h.appended.flatMap((e) => (e as { parts: Array<{ problem?: { code?: string } }> }).parts);
    expect(parts.some((p) => p.problem?.code === 'AUTO_REVIEW_DENIED')).toBe(true);
  });

  it('puts shell kind and the human blockReason on the card payload [AC:auto-review-shell-mcp#AC-6]', () => {
    const decision = evaluateAutoReview({
      toolName: 'bash',
      toolInput: { command: 'rm -rf ./build', requestSmartModeApproval: true }
    });
    expect(decision.action).toBe('require_card');
    if (decision.action !== 'require_card') return;
    expect(decision.kind).toBe('shell');
    expect(decision.blockReason).toMatch(/high-risk pattern/);
    const h = host();
    const flagged = call('bash', { command: 'rm -rf ./build', requestSmartModeApproval: true }, 'c-shell-face');
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals[0]?.reason).toContain(`Auto-review (${decision.kind})`);
    expect(h.approvals[0]?.reason).toContain(decision.blockReason);
    expect(h.approvals[0]?.args).toEqual({ command: 'rm -rf ./build' });
  });

  it('keeps a prior smart-mode note in the human blockReason [AC:auto-review-shell-mcp#AC-6]', () => {
    const decision = evaluateAutoReview({
      toolName: 'bash',
      toolInput: {
        command: 'sudo reboot',
        requestSmartModeApproval: true,
        smartModeBlockReason: 'disk is full'
      }
    });
    expect(decision.action).toBe('require_card');
    if (decision.action !== 'require_card') return;
    expect(decision.kind).toBe('shell');
    expect(decision.blockReason).toContain('high-risk pattern');
    expect(decision.blockReason).toContain('Prior note: disk is full');
  });

  it('explains direct shell isolation on the card payload [AC:auto-review-shell-mcp#AC-6]', () => {
    const decision = evaluateAutoReview({
      toolName: 'bash',
      toolInput: { command: 'printf ok', isolation: 'direct', requestSmartModeApproval: true }
    });
    expect(decision.action).toBe('require_card');
    if (decision.action !== 'require_card') return;
    expect(decision.kind).toBe('shell');
    expect(decision.blockReason).toMatch(/isolation is direct/);
  });

  it('puts mcp kind and a different human blockReason on the card payload [AC:auto-review-shell-mcp#AC-7]', () => {
    const decision = evaluateAutoReview({
      toolName: 'mcp_invoke',
      toolInput: { server: 0, tool: 'delete_all', requestSmartModeApproval: true }
    });
    expect(decision.action).toBe('require_card');
    if (decision.action !== 'require_card') return;
    expect(decision.kind).toBe('mcp');
    expect(decision.blockReason).toMatch(/MCP tool call/);
    expect(decision.blockReason).not.toMatch(/high-risk pattern/);
    const h = host();
    const flagged = call(
      'mcp_invoke',
      { server: 0, tool: 'delete_all', requestSmartModeApproval: true },
      'c-mcp-face'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals[0]?.reason).toContain('Auto-review (mcp)');
    expect(h.approvals[0]?.reason).toContain(decision.blockReason);
  });

  it('stores cited owner ids on the receipt and keeps them after approval [AC:auto-review-authorized-by#AC-1]', () => {
    const h = host();
    const flagged = call(
      'bash',
      {
        command: 'rm -rf ./build',
        requestSmartModeApproval: true,
        authorizedBy: ['tNuowner', 'tNsMcard'],
      },
      'c-cite'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toEqual(['tNuowner', 'tNsMcard']);
    expect(h.approvals[0]?.args).toEqual({ command: 'rm -rf ./build' });
    h.approvals[0]!.status = 'approved';
    expect(h.approvals[0]?.authorizedBy).toEqual(['tNuowner', 'tNsMcard']);
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('proceed');
    expect(h.approvals).toHaveLength(1);
  });

  it('fills a pending receipt from a later authorized_by citation [AC:auto-review-authorized-by#AC-1]', () => {
    const h = host();
    const first = call(
      'mcp_invoke',
      { server: 0, tool: 'delete_all', requestSmartModeApproval: true },
      'c-mcp-open'
    );
    expect(checkToolApprovals(h, tools, [first], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals[0]?.authorizedBy).toBeUndefined();
    expect(checkToolApprovals(h, tools, [first], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toBeUndefined();
    const cited = call(
      'mcp_invoke',
      {
        server: 0,
        tool: 'delete_all',
        requestSmartModeApproval: true,
        authorized_by: ['p-parent', 'tNuowner'],
      },
      'c-mcp-cite'
    );
    expect(checkToolApprovals(h, tools, [cited], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toEqual(['p-parent', 'tNuowner']);
    expect(h.approvals[0]?.args).toEqual({ server: 0, tool: 'delete_all' });
    const other = call(
      'mcp_invoke',
      {
        server: 0,
        tool: 'delete_all',
        requestSmartModeApproval: true,
        authorizedBy: ['tNuother'],
      },
      'c-mcp-other'
    );
    expect(checkToolApprovals(h, tools, [other], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toEqual(['p-parent', 'tNuowner']);
  });

  it('omits the citation when the call does not provide one [AC:auto-review-authorized-by#AC-2]', () => {
    const h = host();
    const flagged = call('bash', { command: 'rm -rf ./build', requestSmartModeApproval: true }, 'c-omit');
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals[0]?.authorizedBy).toBeUndefined();
    h.approvals[0]!.status = 'approved';
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('proceed');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toBeUndefined();
  });

  it('keeps at most four unique stable ids in first-seen order [AC:auto-review-authorized-by#AC-3]', () => {
    const h = host();
    const flagged = call(
      'bash',
      {
        command: 'rm -rf ./build',
        requestSmartModeApproval: true,
        authorizedBy: [' tNu1 ', '', 'tNu1', 'not an id', 2, 'tNsM2', 'p-3', 'tNu4', 'tNu5'],
      },
      'c-cap'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    expect(h.approvals[0]?.authorizedBy).toEqual(['tNu1', 'tNsM2', 'p-3', 'tNu4']);
    expect(h.approvals[0]?.args).toEqual({ command: 'rm -rf ./build' });
    expect(normalizeAuthorizedBy(['', 'not an id'])).toBeUndefined();
    expect(normalizeAuthorizedBy('tNu1')).toBeUndefined();
    expect(normalizeAuthorizedBy([])).toBeUndefined();
    expect(readAuthorizedBy(null)).toBeUndefined();
    expect(readAuthorizedBy([])).toBeUndefined();
    expect(readAuthorizedBy({ authorized_by: [' p-1 ', 'p-1', 'tNu2'] })).toEqual(['p-1', 'tNu2']);
  });

  it('ignores the citation when fingerprinting an approved receipt [AC:auto-review-authorized-by#AC-4]', () => {
    const hash = (name: string, input: unknown) => `${name}:${JSON.stringify(input)}`;
    const plain = evaluateAutoReview({
      toolName: 'bash',
      toolInput: { command: 'rm -rf ./build', requestSmartModeApproval: true },
    });
    const cited = evaluateAutoReview({
      toolName: 'bash',
      toolInput: { command: 'rm -rf ./build', requestSmartModeApproval: true, authorizedBy: ['tNu1'] },
    });
    expect(plain.action).toBe('require_card');
    expect(cited.action).toBe('require_card');
    if (plain.action !== 'require_card' || cited.action !== 'require_card') return;
    expect(cited.fingerprintInput).toEqual(plain.fingerprintInput);
    expect(cited.fingerprintInput).toEqual({ command: 'rm -rf ./build' });
    expect(autoReviewIdempotencyKey('bash', cited.fingerprintInput, hash)).toBe(
      autoReviewIdempotencyKey('bash', plain.fingerprintInput, hash)
    );
    expect(stripAutoReviewFlags({ command: 'rm -rf ./build', authorizedBy: ['tNu9'], authorized_by: ['p-x'] })).toEqual({
      command: 'rm -rf ./build',
    });
    const h = host();
    const flagged = call(
      'bash',
      { command: 'rm -rf ./build', requestSmartModeApproval: true, authorizedBy: ['tNu1'] },
      'c-fp'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, session, undefined)).toBe('waiting');
    h.approvals[0]!.status = 'approved';
    const other = call('bash', { command: 'rm -rf ./build', authorizedBy: ['tNsM9'] }, 'c-fp-2');
    expect(checkToolApprovals(h, tools, [other], ctx, undefined, session, undefined)).toBe('proceed');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.authorizedBy).toEqual(['tNu1']);
  });

  it('does not let a citation skip Auto-review [AC:auto-review-authorized-by#AC-5]', () => {
    const h = host();
    const citedOnly = call('bash', { command: 'rm -rf ./build', authorizedBy: ['tNu1'] }, 'c-nobypass');
    expect(checkToolApprovals(h, tools, [citedOnly], ctx, undefined, session, undefined)).toBe('skip');
    expect(h.approvals).toHaveLength(0);
    const decision = evaluateAutoReview({
      toolName: 'bash',
      toolInput: { command: 'rm -rf ./build', authorizedBy: ['tNu1'] },
    });
    expect(decision.action).toBe('soft_block');
    const bypass = { id: 's1', metadata: { permissionMode: 'bypass' } } as unknown as SessionRecord;
    expect(checkToolApprovals(h, tools, [citedOnly], ctx, undefined, bypass, undefined)).toBe('skip');
    expect(h.approvals).toHaveLength(0);
    const flagged = call(
      'bash',
      { command: 'rm -rf ./build', requestSmartModeApproval: true, authorizedBy: ['tNu1'] },
      'c-still-card'
    );
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, bypass, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.status).toBe('pending');
  });

  it('does not let permissionMode=bypass skip Auto-review [AC:auto-review-shell-mcp#AC-5]', () => {
    const bypass = { id: 's1', metadata: { permissionMode: 'bypass' } } as unknown as SessionRecord;
    const h = host();
    const mcp = call('mcp_invoke', { server: 0, tool: 'delete_all' }, 'c-mcp');
    expect(checkToolApprovals(h, tools, [mcp], ctx, undefined, bypass, undefined)).toBe('skip');
    expect(h.approvals).toHaveLength(0);
    const flagged = call('mcp_invoke', { server: 0, tool: 'delete_all', requestSmartModeApproval: true }, 'c-mcp2');
    expect(checkToolApprovals(h, tools, [flagged], ctx, undefined, bypass, undefined)).toBe('waiting');
    expect(h.approvals).toHaveLength(1);
  });
});

describe('saved direct isolation', () => {
  const session = { id: 's1', metadata: {} } as unknown as SessionRecord;
  const tools = [tool('bash')];
  const listing = call('bash', { command: 'ls -lt ~/Recordings', isolation: 'direct' }, 'c-direct');

  it('does not Auto-review explicit direct when the owner saved direct, but still reviews risky commands [AC:local-source-unlock#AC-3]', () => {
    const saved = host({ savedShellIsolation: () => 'direct' });
    expect(checkToolApprovals(saved, tools, [listing], ctx, undefined, session, undefined)).toBe('proceed');
    expect(saved.appended).toHaveLength(0);
    const risky = call('bash', { command: 'rm -rf ./build', isolation: 'direct' }, 'c-direct-rm');
    expect(checkToolApprovals(saved, tools, [risky], ctx, undefined, session, undefined)).toBe('skip');
    for (const mode of ['auto', 'os', undefined]) {
      const h = host({ savedShellIsolation: () => mode });
      expect(checkToolApprovals(h, tools, [listing], ctx, undefined, session, undefined)).toBe('skip');
    }
  });
});
