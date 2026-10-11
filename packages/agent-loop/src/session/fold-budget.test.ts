import { describe, it, expect, afterEach } from 'vitest';
import { estimateMessageTokens } from '../model/token-estimate.js';
import { createMemorySurfaceStore } from './surface-store.js';
import { runAutoCompact } from './auto-compact.js';
import {
  MAX_VISIBLE_MESSAGES,
  capRollingSummaryText,
  clampFoldKeepRecent,
  clampFoldToVisible,
  compactSummaryMaxChars
} from './fold-budget.js';
import type { AgentSpec, MessagePart, SessionMessage } from '../types.js';

const QUESTION = '有没有类似渗流的大模型涌现论文';
const SYSTEM = 'PageLens system prompt';

function message(
  role: SessionMessage['role'],
  parts: MessagePart[],
  id: string
): SessionMessage {
  return {
    id,
    sessionId: 's',
    role,
    parts,
    createdAt: '2026-10-10T03:31:00.000Z'
  };
}

function textOf(messages: readonly SessionMessage[]): string {
  return messages
    .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text))
    .join('\n');
}

/** A tool result whose assistant tool_call is not in the kept prefix. */
function hasOrphanToolResult(messages: readonly SessionMessage[]): boolean {
  const open = new Set<string>();
  for (const message of messages) {
    const calls: string[] = [];
    const results: string[] = [];
    for (const part of message.parts) {
      if (part.type === 'tool_call') calls.push(part.toolCallId);
      if (part.type === 'tool_result') results.push(part.toolCallId);
    }
    for (const id of results) {
      if (!open.has(id)) return true;
    }
    for (const id of calls) open.add(id);
    for (const id of results) open.delete(id);
  }
  return false;
}

/**
 * Trace shape: 1 system + 1 user question + parallel tool waves (one assistant,
 * two tool results) + a trailing assistant line. The raw tail of 24 messages
 * starts on a tool result and drops the question.
 */
function buildTrace(resultContent = 'ok'): SessionMessage[] {
  const out: SessionMessage[] = [
    message('system', [{ type: 'text', text: SYSTEM }], 'sys'),
    message('user', [{ type: 'text', text: QUESTION }], 'user')
  ];
  for (let w = 0; w < 10; w += 1) {
    const a = `call_${w}_a`;
    const b = `call_${w}_b`;
    out.push(
      message(
        'assistant',
        [
          { type: 'tool_call', toolCallId: a, name: 'navigate_tab', input: { w } },
          { type: 'tool_call', toolCallId: b, name: 'get_page_info', input: { w } }
        ],
        `ast-${w}`
      )
    );
    out.push(
      message(
        'tool',
        [{ type: 'tool_result', toolCallId: a, name: 'navigate_tab', ok: true, content: resultContent }],
        `tool-${w}-a`
      )
    );
    out.push(
      message(
        'tool',
        [{ type: 'tool_result', toolCallId: b, name: 'get_page_info', ok: true, content: resultContent }],
        `tool-${w}-b`
      )
    );
  }
  out.push(message('assistant', [{ type: 'text', text: 'still looking' }], 'tail'));
  return out;
}

const envKeys = ['RAW_AGENT_COMPACT_TOKEN_THRESHOLD', 'RAW_AGENT_MODEL_CONTEXT_TOKENS'] as const;
const savedEnv = new Map<string, string | undefined>();

function setBudgetEnv(threshold: string): void {
  for (const key of envKeys) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.RAW_AGENT_COMPACT_TOKEN_THRESHOLD = threshold;
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('session/fold-budget', () => {
  describe('clampFoldKeepRecent', () => {
    it('never keeps the entire fold', () => {
      expect(clampFoldKeepRecent(10, 10)).toBe(9);
      expect(clampFoldKeepRecent(10, 99)).toBe(9);
    });

    it('honors a smaller keepRecent', () => {
      expect(clampFoldKeepRecent(10, 3)).toBe(3);
    });
  });

  describe('clampFoldToVisible', () => {
    it('returns a copy when the fold fits the count cap', () => {
      const src = [
        message('user', [{ type: 'text', text: 'a' }], 'a'),
        message('assistant', [{ type: 'text', text: 'b' }], 'b')
      ];
      const out = clampFoldToVisible(src, 5);
      expect(out).toEqual(src);
      expect(out).not.toBe(src);
    });

    it('keeps the user question under the token budget when history exceeds 24 [AC:fold-visible-history#AC-1] [AC:fold-visible-history#AC-2]', () => {
      const folded = buildTrace();
      expect(folded.length).toBeGreaterThan(MAX_VISIBLE_MESSAGES);
      const blind = folded.slice(-MAX_VISIBLE_MESSAGES);
      expect(textOf(blind)).not.toContain(QUESTION);
      expect(blind[0]!.role).toBe('tool');

      setBudgetEnv('100000');
      const out = clampFoldToVisible(folded, MAX_VISIBLE_MESSAGES);
      expect(out.length).toBeGreaterThan(MAX_VISIBLE_MESSAGES);
      expect(textOf(out)).toContain(QUESTION);
      expect(textOf(out)).toContain(SYSTEM);
      expect(out[0]!.role).toBe('system');
      expect(hasOrphanToolResult(out)).toBe(false);
      const firstNonSystem = out.find((m) => m.role !== 'system');
      expect(firstNonSystem?.role).not.toBe('tool');
    });

    it('cuts on a closed tool wave and pins system plus the latest user [AC:fold-visible-history#AC-3]', () => {
      const folded = buildTrace('x'.repeat(800));
      const pins = folded.slice(0, 2);
      const trailing = folded.slice(-1);
      const lastWave = folded.slice(-4, -1);
      const previousWave = folded.slice(-7, -4);
      const budget =
        estimateMessageTokens([...pins, ...lastWave, ...trailing]) + 10;
      expect(
        estimateMessageTokens([...pins, ...previousWave, ...lastWave, ...trailing])
      ).toBeGreaterThan(budget);

      setBudgetEnv(String(budget));
      const out = clampFoldToVisible(folded, MAX_VISIBLE_MESSAGES);
      expect(textOf(out)).toContain(QUESTION);
      expect(textOf(out)).toContain(SYSTEM);
      expect(out[0]!.role).toBe('system');
      expect(hasOrphanToolResult(out)).toBe(false);
      expect(out).not.toEqual(folded.slice(-MAX_VISIBLE_MESSAGES));

      const keptCalls = new Set<string>();
      for (const message of out) {
        for (const part of message.parts) {
          if (part.type === 'tool_call') keptCalls.add(part.toolCallId);
        }
      }
      expect([...keptCalls].sort()).toEqual(['call_9_a', 'call_9_b']);
    });
  });

  describe('capRollingSummaryText', () => {
    it('returns empty when maxChars <= 0', () => {
      expect(capRollingSummaryText('hello', 0)).toBe('');
      expect(capRollingSummaryText('hello', -1)).toBe('');
    });

    it('returns the original text when it fits', () => {
      expect(capRollingSummaryText('hello', 10)).toBe('hello');
    });

    it('keeps the tail and prefixes a truncation marker', () => {
      expect(capRollingSummaryText('abcdefghij', 4)).toBe(
        '…[earlier summary truncated]\n\nghij'
      );
    });
  });

  describe('compactSummaryMaxChars', () => {
    it('defaults to tokenThreshold * 2', () => {
      expect(compactSummaryMaxChars({}, 1000)).toBe(2000);
    });

    it('honors explicit env override', () => {
      expect(
        compactSummaryMaxChars({ RAW_AGENT_COMPACT_SUMMARY_MAX_CHARS: '400' }, 1000)
      ).toBe(400);
    });
  });
});

describe('autoCompact summary then closed-wave fallback', () => {
  const agent: AgentSpec = {
    id: 'a',
    name: 'A',
    role: 'assistant',
    instructions: '',
    capabilities: []
  };

  function seedStore(resultContent: string) {
    const store = createMemorySurfaceStore();
    const session = store.createSession({ title: 't', mode: 'chat', agentId: agent.id });
    for (const message of buildTrace(resultContent)) {
      store.appendMessage(session.id, message.role, message.parts);
    }
    return { store, session };
  }

  it('summarizes a closed prefix and keeps the system prompt and latest user [AC:fold-visible-history#AC-4]', async () => {
    const { store, session } = seedStore('x'.repeat(400));
    let sawUser = false;
    let sawSystem = false;
    const result = await runAutoCompact({
      store,
      session,
      agent,
      tokenThreshold: 500,
      summarize: async (messages) => {
        sawUser = messages.some((m) => m.role === 'user');
        sawSystem = messages.some(
          (m) => m.role === 'system' && m.parts.some((p) => p.type === 'text' && p.text === SYSTEM)
        );
        return 'SUMMARY';
      }
    });
    expect(result.didCompact).toBe(true);
    expect(sawUser).toBe(false);
    expect(sawSystem).toBe(false);
    const folded = store.foldMessages(session.id);
    expect(textOf(folded)).toContain(QUESTION);
    expect(textOf(folded)).toContain(SYSTEM);
    expect(textOf(folded)).toContain('SUMMARY');
    expect(hasOrphanToolResult(folded)).toBe(false);
  });

  it('falls back to pin-user and closed waves when summary fails [AC:fold-visible-history#AC-5]', async () => {
    const { store, session } = seedStore('x'.repeat(800));
    const before = store.foldMessages(session.id);
    await expect(
      runAutoCompact({
        store,
        session,
        agent,
        tokenThreshold: 200,
        summarize: async () => {
          throw new Error('summarizer down');
        }
      })
    ).rejects.toThrow(/summarizer down/);
    expect(store.foldMessages(session.id)).toEqual(before);

    const pins = before.slice(0, 2);
    const trailing = before.slice(-1);
    const lastWave = before.slice(-4, -1);
    const budget = estimateMessageTokens([...pins, ...lastWave, ...trailing]) + 10;
    setBudgetEnv(String(budget));
    const out = clampFoldToVisible(before, MAX_VISIBLE_MESSAGES);
    expect(textOf(out)).toContain(QUESTION);
    expect(textOf(out)).toContain(SYSTEM);
    expect(hasOrphanToolResult(out)).toBe(false);
    expect(out).not.toEqual(before.slice(-MAX_VISIBLE_MESSAGES));
    expect(out.length).toBeLessThan(before.length);
  });
});
