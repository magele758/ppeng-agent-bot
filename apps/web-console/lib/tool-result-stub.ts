/** Browser-side parser for micro-compact stubs. Keep in sync with core `session/tool-result-stub.ts`. */

export const TOOL_RESULT_STUB_MARK = 'earlier tool output was omitted to save space';

export interface ToolResultStubRef {
  messageId: string;
  partIndex: number;
  seq?: number;
}

const STUB_PREFIX = /\[previous: used \S+(?: \(failed\))? — earlier tool output was omitted to save space\]/;

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
