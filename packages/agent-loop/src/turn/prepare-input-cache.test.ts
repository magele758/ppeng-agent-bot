import { describe, expect, it } from 'vitest';
import { prepareTurnInput } from './prepare-turn-input.js';
import type { SessionMessage, SessionRecord } from '../types.js';

function message(sessionId: string, text: string, seq: number): SessionMessage {
  return {
    id: `${sessionId}-${seq}`,
    sessionId,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: '2026-10-28T00:00:00.000Z',
    seq
  };
}

describe('prepare input cache', () => {
  it('does not rebuild the view or memory appendix when the fold is unchanged [AC:loop-prefix-cache#AC-5]', async () => {
    const sessionId = 'prepare-cache-stable';
    const traces: string[] = [];
    let views = 0;
    let appendices = 0;
    const session = {
      id: sessionId,
      summary: '',
      updatedAt: '2026-10-28T00:00:00.000Z'
    } as SessionRecord;
    const folded = [message(sessionId, 'same', 1), message(sessionId, 'tail', 2)];
    const deps = {
      store: {
        getSession: () => session,
        foldMessages: () => folded,
        appendMessage: () => folded[0]!
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      prepareView: async (_session: SessionRecord, messages: SessionMessage[]) => {
        views += 1;
        return messages;
      },
      buildAppendix: async () => {
        appendices += 1;
        return 'appendix';
      },
      emitTrace: (_id: string, event: { payload: { phase?: string } }) => {
        if (event.payload.phase) traces.push(event.payload.phase);
      }
    };

    const first = await prepareTurnInput(sessionId, deps);
    const second = await prepareTurnInput(sessionId, deps);

    expect(first.messages.at(-1)?.parts.some((part) => part.type === 'text' && part.text.includes('appendix'))).toBe(true);
    expect(second.messages.at(-1)?.parts.some((part) => part.type === 'text' && part.text.includes('appendix'))).toBe(true);
    expect(views).toBe(1);
    expect(appendices).toBe(1);
    expect(traces.filter((phase) => phase === 'prepare_view')).toEqual(['prepare_view']);
    expect(traces.filter((phase) => phase === 'memory_appendix')).toEqual(['memory_appendix']);
    expect(traces.filter((phase) => phase === 'fold_messages')).toHaveLength(2);
  });
});
