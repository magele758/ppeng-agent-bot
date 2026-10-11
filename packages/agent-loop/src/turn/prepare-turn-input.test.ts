import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clampFoldToVisible } from '../session/fold-budget.js';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import { appendWorkingLogEntry, readWorkingLogTail, workingLogPath } from '../session/working-log.js';
import {
  applyMemoryAppendixToMessages,
  lastUserQueryFromMessages,
  prepareTurnInput,
  WORKING_LOG_APPENDIX_HEAD,
} from './prepare-turn-input.js';
import type { SessionMessage, SessionRecord } from '../types.js';

function textMsg(
  sessionId: string,
  role: SessionMessage['role'],
  text: string,
  seq: number
): SessionMessage {
  return {
    id: `m${seq}`,
    sessionId,
    role,
    parts: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
    seq,
  };
}

describe('prepareTurnInput', () => {
  it('runs autoCompact → claim → fold → clamp → view → appendix on a view copy', async () => {
    const surface = createMemorySurfaceStore();
    const session = surface.createSession({ title: 't', mode: 'chat', agentId: 'a' });
    surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello' }]);
    surface.enqueueSteer(session.id, 'steer me', { target: 'next-step' });

    const order: string[] = [];
    let compactCalls = 0;
    const packed = await prepareTurnInput(session.id, {
      store: {
        getSession: (id) => surface.getSession(id),
        foldMessages: (id) => surface.foldMessages(id),
        appendMessage: (id, role, parts, opts) => surface.appendMessage(id, role, parts, opts),
        hideByKey: (id, key) => surface.hideByKey(id, key),
      },
      autoCompact: async () => {
        compactCalls += 1;
        order.push('compact');
      },
      claimNextStep: () => {
        order.push('claim');
        return surface.claimInbox(session.id, 'next-step');
      },
      applyFoldBudget: (_s, folded) => {
        order.push('fold');
        return clampFoldToVisible(folded, 24);
      },
      prepareView: async (_s, msgs) => {
        order.push('view');
        return msgs;
      },
      buildAppendix: (_s, pack) => {
        order.push('appendix');
        expect(pack?.viewMessages.some((m) => m.role === 'user')).toBe(true);
        return '[memory] note';
      },
    });

    expect(order).toEqual(['compact', 'claim', 'fold', 'view', 'appendix']);
    expect(compactCalls).toBe(1);
    expect(packed.claimedInbox).toHaveLength(1);
    expect(packed.foldSeqs.length).toBeGreaterThan(0);
    const lastUser = [...packed.messages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.parts.some((p) => p.type === 'text' && p.text.includes('[memory] note'))).toBe(
      true
    );
    const walUser = surface
      .foldMessages(session.id)
      .filter((m) => m.role === 'user')
      .at(-1);
    expect(walUser?.parts.some((p) => p.type === 'text' && p.text.includes('[memory] note'))).toBe(
      false
    );
  });

  it('clamps fold budget before view', async () => {
    const session: SessionRecord = {
      id: 's1',
      title: 't',
      mode: 'chat',
      status: 'idle',
      agentId: 'a',
      background: false,
      todo: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const folded = Array.from({ length: 30 }, (_, i) => textMsg('s1', i % 2 ? 'assistant' : 'user', `m${i}`, i + 1));
    let viewed = 0;
    const packed = await prepareTurnInput('s1', {
      store: {
        getSession: () => session,
        foldMessages: () => folded,
        appendMessage: () => folded[0]!,
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      applyFoldBudget: (_s, msgs) => clampFoldToVisible(msgs, { maxVisible: 8, tokenBudget: 20 }),
      prepareView: async (_s, msgs) => {
        viewed = msgs.length;
        return msgs;
      },
      buildAppendix: () => '',
    });
    expect(viewed).toBe(packed.messages.length);
    expect(viewed).toBeLessThan(folded.length);
    expect(packed.foldSeqs).toHaveLength(30);
    const latestUser = [...packed.messages].reverse().find((m) => m.role === 'user');
    expect(latestUser?.parts.some((p) => p.type === 'text' && p.text === 'm28')).toBe(true);
  });

  it('falls back to working-log tail on the view copy when appendix is empty', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'al-prep-wlog-'));
    const surface = createMemorySurfaceStore();
    const session = surface.createSession({ title: 't', mode: 'chat', agentId: 'a' });
    surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello' }]);
    appendWorkingLogEntry(workingLogPath(stateDir, session.id), {
      kind: 'compact_anchor',
      content: 'archived to /tmp/transcript.jsonl',
      ref: '/tmp/transcript.jsonl',
    });
    try {
      const packed = await prepareTurnInput(session.id, {
        store: {
          getSession: (id) => surface.getSession(id),
          foldMessages: (id) => surface.foldMessages(id),
          appendMessage: (id, role, parts, opts) => surface.appendMessage(id, role, parts, opts),
        },
        autoCompact: async () => undefined,
        claimNextStep: () => [],
        prepareView: async (_s, msgs) => msgs,
        buildAppendix: () => '',
        readWorkingLogTail: (id) => readWorkingLogTail(workingLogPath(stateDir, id)),
      });
      const lastUser = [...packed.messages].reverse().find((m) => m.role === 'user');
      const packedText = lastUser?.parts
        .filter((p): p is Extract<(typeof lastUser.parts)[number], { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      expect(packedText).toContain(WORKING_LOG_APPENDIX_HEAD);
      expect(packedText).toContain('archived to /tmp/transcript.jsonl');
      const walUser = surface
        .foldMessages(session.id)
        .filter((m) => m.role === 'user')
        .at(-1);
      expect(
        walUser?.parts.some((p) => p.type === 'text' && p.text.includes(WORKING_LOG_APPENDIX_HEAD))
      ).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('applyMemoryAppendixToMessages', () => {
  it('prefixes the last user message without mutating the source', () => {
    const src = [textMsg('s', 'user', 'hi', 1)];
    const out = applyMemoryAppendixToMessages(src, '[mem]');
    expect(src[0]!.parts[0]).toEqual({ type: 'text', text: 'hi' });
    expect(out[0]!.parts[0]).toEqual({ type: 'text', text: '[mem]\n\n' });
    expect(lastUserQueryFromMessages(src)).toBe('hi');
  });
});
