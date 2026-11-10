import { AsyncLocalStorage } from 'node:async_hooks';

export const SOURCE_UNAVAILABLE = 'SOURCE_UNAVAILABLE';

interface MemoryReadResult {
  ok: boolean;
  content: string;
}

interface MemoryReadTurn {
  failed: Set<string>;
  inflight: Map<string, Promise<MemoryReadResult>>;
}

const turns = new AsyncLocalStorage<MemoryReadTurn>();

/** One user turn. Nested calls keep the same unavailable-source set. */
export function runWithMemoryReadTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (turns.getStore()) return fn();
  return turns.run({ failed: new Set(), inflight: new Map() }, fn);
}

export function sourceUnavailableResult(ref: string, surfaced: boolean): { ok: false; content: string } {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'Source unavailable.',
      error_code: SOURCE_UNAVAILABLE,
      ref,
      retry: false,
      ...(surfaced ? { surfaced: true } : {})
    })
  };
}

export function isSourceUnavailableContent(content: string): boolean {
  try {
    return (JSON.parse(content) as { error_code?: unknown }).error_code === SOURCE_UNAVAILABLE;
  } catch {
    return false;
  }
}

function sourceKey(ref: unknown): string {
  return typeof ref === 'string' ? ref : JSON.stringify(ref ?? '');
}

/**
 * Run `read` unless this turn already surfaced SOURCE_UNAVAILABLE for the same ref.
 * A successful read stays callable so paging can continue. Outside a turn, every call runs.
 */
export function guardMemoryRead<T extends MemoryReadResult>(
  ref: unknown,
  read: () => Promise<T>
): Promise<T | { ok: false; content: string }> {
  const turn = turns.getStore();
  if (!turn) return read();
  return guardInTurn(turn, sourceKey(ref), read);
}

function guardInTurn<T extends MemoryReadResult>(
  turn: MemoryReadTurn,
  key: string,
  read: () => Promise<T>
): Promise<T | { ok: false; content: string }> {
  if (turn.failed.has(key)) return Promise.resolve(sourceUnavailableResult(key, true));
  const pending = turn.inflight.get(key);
  if (pending) return afterInflight(turn, key, pending, read);
  return runFirst(turn, key, read);
}

async function afterInflight<T extends MemoryReadResult>(
  turn: MemoryReadTurn,
  key: string,
  pending: Promise<MemoryReadResult>,
  read: () => Promise<T>
): Promise<T | { ok: false; content: string }> {
  const first = await pending;
  if (!first.ok && isSourceUnavailableContent(first.content)) return sourceUnavailableResult(key, true);
  return read();
}

async function runFirst<T extends MemoryReadResult>(
  turn: MemoryReadTurn,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const promise = read();
  turn.inflight.set(key, promise);
  try {
    const result = await promise;
    if (!result.ok && isSourceUnavailableContent(result.content)) turn.failed.add(key);
    return result;
  } finally {
    turn.inflight.delete(key);
  }
}
