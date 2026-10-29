/**
 * Skip prepare_view / memory_appendix when the fold view and appendix inputs
 * are unchanged. The key stays in memory; traces never receive message text.
 */

import type { SessionMessage } from '../types.js';

const CACHE_MAX = 512;

export interface CachedPrepareSlice {
  viewKey: string;
  view: SessionMessage[];
  appendixKey: string;
  appendix: string;
}

const cache = new Map<string, CachedPrepareSlice>();

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ value, 16777619);
}

function mixText(hash: number, text: string): number {
  let next = mix(hash, text.length);
  const step = Math.max(1, Math.floor(text.length / 16));
  for (let i = 0; i < text.length; i += step) next = mix(next, text.charCodeAt(i));
  return next;
}

/** Fingerprint of the messages that feed the model view. */
export function messageViewKey(messages: readonly SessionMessage[]): string {
  let hash = 2166136261;
  hash = mix(hash, messages.length);
  for (const message of messages) {
    hash = mix(hash, message.seq ?? 0);
    hash = mixText(hash, message.id);
    hash = mixText(hash, message.role);
    hash = mixText(hash, message.key ?? '');
    for (const part of message.parts) hash = mixText(hash, JSON.stringify(part));
  }
  return (hash >>> 0).toString(16);
}

export function readPrepareSlice(sessionId: string): CachedPrepareSlice | undefined {
  return cache.get(sessionId);
}

export function writePrepareSlice(sessionId: string, slice: CachedPrepareSlice): void {
  if (!cache.has(sessionId) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(sessionId, slice);
}

export function copyView(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.map((message) => ({ ...message, parts: [...message.parts] }));
}
