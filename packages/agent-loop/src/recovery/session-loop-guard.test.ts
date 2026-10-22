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
