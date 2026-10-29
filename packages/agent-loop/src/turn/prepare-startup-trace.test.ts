import { describe, expect, it } from 'vitest';
import { prepareTurnInput } from './prepare-turn-input.js';
import type { SessionMessage, SessionRecord } from '../types.js';

const PLANTED = 'planted-message-body-should-not-leak-9f3a';

function message(text: string, seq: number): SessionMessage {
  return {
    id: `m${seq}`,
    sessionId: 's1',
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: '2026-10-28T00:00:00.000Z',
    seq
  };
}

describe('prepare startup traces', () => {
  it('keeps compact, fold, view, and prepare_turn while timing budget and appendix [AC:bot-startup-trace#AC-4]', async () => {
    const traces: Array<{ kind: string; payload: Record<string, unknown>; data?: Record<string, unknown> }> = [];
    const session = { id: 's1' } as SessionRecord;
    const folded = [message(PLANTED, 1), message('later', 2)];
    const packed = await prepareTurnInput('s1', {
      store: {
        getSession: () => session,
        foldMessages: () => folded,
        appendMessage: () => folded[0]!
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      prepareView: async (_session, messages) => messages,
      buildAppendix: async () => '',
      readWorkingLogTail: () => '',
      emitTrace: (_id, event) => {
        traces.push(event);
      }
    });

    expect(packed.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes(PLANTED)))).toBe(true);
    const phases = traces.filter((event) => event.kind === 'startup_phase').map((event) => event.payload);
    const names = phases.map((payload) => payload.phase);
    for (const phase of ['auto_compact', 'fold_messages', 'prepare_view', 'prepare_turn', 'fold_budget', 'memory_appendix']) {
      expect(names).toContain(phase);
    }
    const budget = phases.find((payload) => payload.phase === 'fold_budget');
    const appendix = phases.find((payload) => payload.phase === 'memory_appendix');
    expect(typeof budget?.durationMs).toBe('number');
    expect(typeof appendix?.durationMs).toBe('number');
    expect(budget).not.toBe(appendix);
    expect(JSON.stringify(phases)).not.toContain(PLANTED);
    expect(traces.every((event) => event.data === event.payload)).toBe(true);
  });

  it('records a skipped fold budget and ignores a throwing tracer [AC:bot-startup-trace#AC-4]', async () => {
    const phases: string[] = [];
    const session = { id: 's1' } as SessionRecord;
    await prepareTurnInput('s1', {
      store: {
        getSession: () => session,
        foldMessages: () => [message(PLANTED, 3)],
        appendMessage: () => message('x', 1)
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      prepareView: async (_session, messages) => messages,
      buildAppendix: async () => PLANTED,
      emitTrace: () => {
        phases.push('called');
        throw new Error(PLANTED);
      }
    });
    expect(phases.length).toBeGreaterThan(0);
  });
});
