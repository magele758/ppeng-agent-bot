import { describe, it, expect } from 'vitest';
import { SessionLoopGuard } from './session-loop-guard.js';
import type { MessagePart } from '../types.js';

describe('recovery/session-loop-guard', () => {
  const textPart = (text: string): MessagePart => ({ type: 'text', text });

  describe('checkAssistantRepetition', () => {
    it('returns abort:false for first response', () => {
      const guard = new SessionLoopGuard({});
      const result = guard.checkAssistantRepetition([textPart('First response')]);
      expect(result.abort).toBe(false);
    });

    it('returns abort:false for varied responses', () => {
      const guard = new SessionLoopGuard({});
      guard.checkAssistantRepetition([textPart('response one')]);
      guard.checkAssistantRepetition([textPart('response two')]);
      guard.checkAssistantRepetition([textPart('response three')]);
      guard.checkAssistantRepetition([textPart('response four')]);
      const result = guard.checkAssistantRepetition([textPart('response five')]);
      expect(result.abort).toBe(false);
    });

    it('detects near-identical assistant messages past the window', () => {
      // default repeatRatio fires at >= threshold identical fingerprints in last N turns
      // use 8 identical in a row to force it
      const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_REPEAT_WINDOW: '8' });
      const sameParts = [textPart('I will now proceed to read the file and analyze it carefully.')];
      for (let i = 0; i < 8; i++) {
        guard.checkAssistantRepetition(sameParts);
      }
      const result = guard.checkAssistantRepetition(sameParts);
      expect(result.abort).toBe(true);
      if (result.abort) {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  describe('afterToolRound', () => {
    it('returns abort:false for single successful tool call', () => {
      const guard = new SessionLoopGuard({});
      const result = guard.afterToolRound(
        [{ name: 'read', input: { path: 'file.ts' } }],
        [{ name: 'read', ok: true }]
      );
      expect(result.abort).toBe(false);
    });

    it('returns abort:false for varied tool calls', () => {
      const guard = new SessionLoopGuard({});
      guard.afterToolRound([{ name: 'read', input: { path: 'a.ts' } }], [{ name: 'read', ok: true }]);
      guard.afterToolRound([{ name: 'read', input: { path: 'b.ts' } }], [{ name: 'read', ok: true }]);
      const result = guard.afterToolRound(
        [{ name: 'read', input: { path: 'c.ts' } }],
        [{ name: 'read', ok: true }]
      );
      expect(result.abort).toBe(false);
    });

    it('detects tool fail streak for same tool', () => {
      const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '3' });
      const call = [{ name: 'bash', input: { cmd: 'ls' } }];
      const fail = [{ name: 'bash', ok: false }];
      guard.afterToolRound(call, fail);
      guard.afterToolRound(call, fail);
      const result = guard.afterToolRound(call, fail);
      expect(result.abort).toBe(true);
    });

    it('detects same call content streak', () => {
      const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
      const sameCall = [{ name: 'bash', input: { cmd: 'git status' } }];
      const ok = [{ name: 'bash', ok: true }];
      guard.afterToolRound(sameCall, ok);
      guard.afterToolRound(sameCall, ok);
      const result = guard.afterToolRound(sameCall, ok);
      expect(result.abort).toBe(true);
      if (result.abort) expect(result.reason).toMatch(/^repeat detection: same tool-call content/);
    });
  });
});

describe('tool result progress', () => {
  const call = [{ name: 'status', input: { task: 'a' } }];
  it('allows new evidence and identical narration [AC:tool-progress-guard#AC-1]', () => {
    const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
    for (let i = 0; i < 10; i++) {
      expect(guard.checkAssistantRepetition([{ type: 'tool_call', toolCallId: String(i), ...call[0]! }]).abort).toBe(false);
      expect(guard.afterToolRound(call, [{ name: 'status', ok: true, content: JSON.stringify({ completed: i }) }]).abort).toBe(false);
    }
    expect(guard.sameToolStreak).toBe(1);
  });
  it('ignores observation noise and repeated old states [AC:tool-progress-guard#AC-2]', () => {
    const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
    for (let i = 0; i < 3; i++) {
      const decision = guard.afterToolRound(call, [{ name: 'status', ok: true, content: JSON.stringify({ status: 'pending', timestamp: i, requestId: String(i), durationMs: i }) }]);
      expect(decision.abort).toBe(i === 2);
    }
    const cycling = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
    const decisions = ['A', 'B', 'A', 'B'].map(content => cycling.afterToolRound(call, [{ name: 'status', ok: true, content }]));
    expect(decisions[3]!.abort).toBe(true);
  });
  it('does not count changed errors or missing results as progress [AC:tool-progress-guard#AC-3]', () => {
    const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '3' });
    for (let i = 0; i < 3; i++) {
      expect(guard.afterToolRound(call, [{ name: 'status', ok: false, content: `failure ${i}` }]).abort).toBe(i === 2);
    }
    const missing = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
    missing.afterToolRound(call, []);
    missing.afterToolRound(call, []);
    expect(missing.afterToolRound(call, []).abort).toBe(true);
  });
});

describe('progress evidence boundaries', () => {
  it('preserves business timestamps and plain text evidence [AC:tool-progress-guard#AC-1]', () => {
    for (const json of [true, false]) {
      const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '2' });
      for (let i = 0; i < 8; i++) {
        const content = `2026-10-23T12:00:0${i}Z`;
        expect(guard.afterToolRound([{ name: 'read' }], [{ name: 'read', ok: true, content: json ? JSON.stringify({ deployedAt: content }) : content }]).abort).toBe(false);
      }
    }
  });
  it('tracks alternating calls without mistaking new evidence elsewhere for a stall [AC:tool-progress-guard#AC-2]', () => {
    const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
    let decision: { abort: boolean } = { abort: false };
    for (let i = 0; i < 6; i++) {
      const name = i % 2 ? 'read_a' : 'read_b';
      decision = guard.afterToolRound([{ name }], [{ name, ok: true, content: 'unchanged' }]);
    }
    expect(decision.abort).toBe(true);
    expect(guard.afterToolRound([{ name: 'read_a' }], [{ name: 'read_a', ok: true, content: 'new evidence' }]).abort).toBe(false);
    expect(guard.afterToolRound([{ name: 'read_b' }], [{ name: 'read_b', ok: true, content: 'unchanged' }]).abort).toBe(false);
  });
  it('pairs concurrent results by id and conservatively handles partial results [AC:tool-progress-guard#AC-3]', () => {
    const calls = [{ name: 'read', toolCallId: 'a' }, { name: 'read', toolCallId: 'b' }];
    const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '2' });
    for (let i = 0; i < 6; i++) {
      expect(guard.afterToolRound(calls, [
        { name: 'read', toolCallId: 'b', ok: true, content: 'fixed' },
        { name: 'read', toolCallId: 'a', ok: true, content: String(i) },
      ]).abort).toBe(false);
    }
    expect(guard.afterToolRound(calls, [{ name: 'read', toolCallId: 'a', ok: true, content: 'new but incomplete' }]).abort).toBe(true);
  });
});
