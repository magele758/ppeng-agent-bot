import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../types.js';
import { microCompactMessages, DEFAULT_MICRO_COMPACT_CONFIG } from './micro-compact.js';
import {
  TOOL_RESULT_STUB_MARK,
  formatToolResultStub,
  isToolResultStub,
  parseToolResultStubRef
} from './tool-result-stub.js';

const OMITTED = 'earlier tool output was omitted to save space';

function toolMsg(
  id: string,
  name: string,
  content: string,
  ok = true,
  extra?: Partial<SessionMessage>
): SessionMessage {
  return {
    id,
    sessionId: 's1',
    role: 'tool',
    parts: [{ type: 'tool_result', toolCallId: `c-${id}`, name, ok, content }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra
  };
}

describe('micro-compact tool-result stub wording', () => {
  it('says the earlier tool output was omitted to save space and keeps the tool name [AC:micro-compact-stub-wording#AC-1]', () => {
    const text = formatToolResultStub('bash', true);
    expect(text).toContain(OMITTED);
    expect(text).toContain('bash');
    expect(TOOL_RESULT_STUB_MARK).toBe(OMITTED);

    const input = [
      toolMsg('1', 'bash', 'a'.repeat(400)),
      toolMsg('2', 'read_file', 'b'.repeat(400)),
      toolMsg('3', 'grep', 'c'.repeat(400))
    ];
    const { messages } = microCompactMessages(input, {
      ...DEFAULT_MICRO_COMPACT_CONFIG,
      keepRecent: 1,
      minChars: 10
    });
    const stub = messages[0]!.parts[0]!;
    expect(stub.type).toBe('tool_result');
    if (stub.type !== 'tool_result') return;
    expect(stub.content).toContain(OMITTED);
    expect(stub.content).toContain('bash');
    expect(messages[2]!.parts[0]).toMatchObject({ content: 'c'.repeat(400) });
  });

  it('does not say the user context or that output was dropped from context [AC:micro-compact-stub-wording#AC-2]', () => {
    const samples = [
      formatToolResultStub('web_search', true, {
        messageId: 'msg_5910bfdb1e204513a038ce6ad5c6ca13',
        partIndex: 0,
        seq: 12
      }),
      formatToolResultStub('get_page_info', false)
    ];
    for (const text of samples) {
      const lower = text.toLowerCase();
      expect(lower).not.toContain('output dropped from context');
      expect(lower).not.toContain('user context');
      expect(lower).not.toContain('dropped from context');
      expect(lower).not.toMatch(/\bcontext\b/);
      expect(lower).not.toMatch(/compress/);
      expect(lower).not.toMatch(/conversation/);
    }
  });

  it('keeps message id, part index, and seq on the stub [AC:micro-compact-stub-wording#AC-3]', () => {
    const text = formatToolResultStub('navigate_tab', true, {
      messageId: 'msg_5910bfdb1e204513a038ce6ad5c6ca13',
      partIndex: 2,
      seq: 40
    });
    expect(text).toBe(
      `[previous: used navigate_tab — ${OMITTED}] msg=msg_5910bfdb1e204513a038ce6ad5c6ca13 part=2 seq=40`
    );
    expect(isToolResultStub(text)).toBe(true);
    expect(parseToolResultStubRef(text)).toEqual({
      messageId: 'msg_5910bfdb1e204513a038ce6ad5c6ca13',
      partIndex: 2,
      seq: 40
    });

    const input: SessionMessage[] = [
      {
        id: 'msg_abc',
        sessionId: 's1',
        role: 'tool',
        seq: 9,
        parts: [
          { type: 'text', text: 'note' },
          {
            type: 'tool_result',
            toolCallId: 'c-abc',
            name: 'get_links',
            ok: true,
            content: 'x'.repeat(200)
          }
        ],
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      toolMsg('keep', 'bash', 'recent')
    ];
    const { messages } = microCompactMessages(input, {
      ...DEFAULT_MICRO_COMPACT_CONFIG,
      keepRecent: 1,
      minChars: 10
    });
    const part = messages[0]!.parts[1]!;
    expect(part.type).toBe('tool_result');
    if (part.type !== 'tool_result') return;
    expect(part.content).toContain('msg=msg_abc');
    expect(part.content).toContain('part=1');
    expect(part.content).toContain('seq=9');
    expect(part.content).toContain('get_links');
    expect(parseToolResultStubRef(part.content)).toEqual({
      messageId: 'msg_abc',
      partIndex: 1,
      seq: 9
    });
  });

  it('still marks a failed tool when its output is omitted [AC:micro-compact-stub-wording#AC-4]', () => {
    const text = formatToolResultStub('grep', false, {
      messageId: 'msg_fail',
      partIndex: 0
    });
    expect(text).toBe(`[previous: used grep (failed) — ${OMITTED}] msg=msg_fail part=0`);
    expect(isToolResultStub(text)).toBe(true);
    expect(text).not.toContain('output dropped from context');

    const { messages } = microCompactMessages(
      [
        toolMsg('1', 'bash', 'stack trace '.repeat(40), false, { seq: 3 }),
        toolMsg('2', 'bash', 'ok'),
        toolMsg('3', 'bash', 'ok')
      ],
      { ...DEFAULT_MICRO_COMPACT_CONFIG, keepRecent: 2, minChars: 10 }
    );
    const part = messages[0]!.parts[0]!;
    expect(part.type).toBe('tool_result');
    if (part.type !== 'tool_result') return;
    expect(part.content).toContain('(failed)');
    expect(part.content).toContain(OMITTED);
    expect(part.content).toContain('bash');
  });
});
