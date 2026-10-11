/**
 * Addressable micro-compact stubs.
 *
 * The line names the tool and says its earlier output was omitted to save
 * space. It must not say the user context was dropped or that the conversation
 * was compressed — models repeat that wording to the user.
 * The suffix is the index: message id + part (and seq when the WAL has one).
 * Keep in sync with `@ppeng/agent-loop` `session/tool-result-stub.ts`.
 */

export const TOOL_RESULT_STUB_MARK = 'earlier tool output was omitted to save space';

export interface ToolResultStubAddr {
  messageId: string;
  partIndex: number;
  seq?: number;
}

/** Parsed pointer; aliases {@link ToolResultStubAddr}. */
export type ToolResultStubRef = ToolResultStubAddr;

const STUB_PREFIX = /\[previous: used \S+(?: \(failed\))? — earlier tool output was omitted to save space\]/;

export function formatToolResultStub(name: string, ok: boolean, addr?: ToolResultStubAddr): string {
  const head = `[previous: used ${name}${ok ? '' : ' (failed)'} — ${TOOL_RESULT_STUB_MARK}]`;
  if (!addr) return head;
  const messageId = addr.messageId.trim();
  if (!messageId) return head;
  const partIndex = Number.isFinite(addr.partIndex) ? Math.max(0, Math.floor(addr.partIndex)) : 0;
  const bits = [`msg=${messageId}`, `part=${partIndex}`];
  if (typeof addr.seq === 'number' && Number.isFinite(addr.seq)) {
    bits.push(`seq=${Math.floor(addr.seq)}`);
  }
  return `${head} ${bits.join(' ')}`;
}

export function isToolResultStub(text: string): boolean {
  return typeof text === 'string' && STUB_PREFIX.test(text) && text.includes(TOOL_RESULT_STUB_MARK);
}

export function parseToolResultStubRef(text: string): ToolResultStubRef | undefined {
  if (!isToolResultStub(text)) return undefined;
  const messageId = /(?:^|\s)msg=(\S+)/.exec(text)?.[1];
  if (!messageId) return undefined;
  const partRaw = /(?:^|\s)part=(\d+)/.exec(text)?.[1];
  const seqRaw = /(?:^|\s)seq=(\d+)/.exec(text)?.[1];
  const ref: ToolResultStubRef = {
    messageId,
    partIndex: partRaw !== undefined ? Number(partRaw) : 0
  };
  if (seqRaw !== undefined) ref.seq = Number(seqRaw);
  return ref;
}
