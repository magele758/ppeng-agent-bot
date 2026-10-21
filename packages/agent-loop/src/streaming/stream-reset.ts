/**
 * Retry / provider fallback re-runs a model turn from scratch. Without a marker
 * the client would append the second attempt to the partial output of the
 * failed one ("PARTIAL PARTIAL full answer"); the transcript itself is clean
 * because only the successful attempt is persisted.
 */
import type { ModelStreamChunk, StreamResetReason } from '../types.js';

export interface StreamResetTracker {
  /** Forward a chunk to the client, remembering whether the current attempt streamed anything. */
  onChunk(chunk: ModelStreamChunk): void;
  /** Emit `stream_reset` if the failed attempt already streamed output. */
  resetIfDirty(reason: StreamResetReason): void;
}

export function createStreamResetTracker(onStream: (chunk: ModelStreamChunk) => void): StreamResetTracker {
  let dirty = false;
  return {
    onChunk(chunk) {
      if (chunk.type !== 'model_retry') dirty = chunk.type !== 'stream_reset';
      onStream(chunk);
    },
    resetIfDirty(reason) {
      if (!dirty) return;
      dirty = false;
      onStream({ type: 'stream_reset', reason });
    }
  };
}
