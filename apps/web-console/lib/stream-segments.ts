/**
 * 流式 SSE 中按时间顺序展示的片段（思考 / 正文 / 工具参数流 / A2UI surface）。
 */
export type StreamSegment = { messageId?: string } & (
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'text'; id: string; raw: string; html: string }
  | { kind: 'tool'; id: string; toolCallId: string; name: string; args: string }
  /**
   * Live A2UI surface accumulating envelopes from `a2ui_message` chunks. The
   * renderer folds them once per render to derive the current SurfaceState.
   * `surfaceId` keys a single segment per surface — a second envelope for the
   * same surface mutates this segment in place rather than appending a new one.
   */
  | { kind: 'a2ui'; id: string; surfaceId: string; catalogId: string; envelopes: unknown[] });

/**
 * Segments as of the last `done` chunk. Deltas merge into the last segment, so its
 * content is copied too; `stream_reset` (model retry / fallback) rolls back to it.
 */
export interface StreamCheckpoint {
  count: number;
  last?: StreamSegment;
}

function copySegment(seg: StreamSegment): StreamSegment {
  return seg.kind === 'a2ui' ? { ...seg, envelopes: [...seg.envelopes] } : { ...seg };
}

export function streamCheckpoint(segments: readonly StreamSegment[]): StreamCheckpoint {
  const last = segments[segments.length - 1];
  return last ? { count: segments.length, last: copySegment(last) } : { count: 0 };
}

/** Drop everything streamed since `checkpoint`, in place. */
export function rollbackToCheckpoint(segments: StreamSegment[], checkpoint: StreamCheckpoint): void {
  segments.length = Math.min(segments.length, checkpoint.count);
  if (checkpoint.last && segments.length === checkpoint.count) {
    segments[checkpoint.count - 1] = copySegment(checkpoint.last);
  }
}

export function formatStreamToolArgs(args: string): string {
  const t = args.trim();
  if (!t) return '…';
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

/** Close the model shot by durable identity. New deltas start a new segment. */
export function markStreamSaved(segments: StreamSegment[], messageId: string): void {
  for (const segment of segments) {
    if (!segment.messageId && segment.kind !== 'a2ui') segment.messageId = messageId;
  }
}

export function streamTailCanMerge(segment: StreamSegment | undefined, kind: StreamSegment['kind']): boolean {
  return segment?.kind === kind && !segment.messageId;
}

export function applySavedStreamEvent(event: string, payload: {type?: string; messageId?: string}, segments: StreamSegment[]): boolean {
  if (event !== 'model' || payload.type !== 'assistant_saved' || !payload.messageId) return false;
  markStreamSaved(segments, payload.messageId);
  return true;
}

/** Empty ID means a tracked new shot has not been saved yet. Undefined is legacy. */
export function pendingStreamIdentity(enabled: boolean): {messageId?: string} {
  return enabled ? {messageId: ''} : {};
}
