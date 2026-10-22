import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceEvent } from './trace.js';

/** Hard cap already used by readers. Callers that need the whole tail pass this, not 500. */
export const SESSION_TRACE_READ_MAX = 5000;

export interface SessionTracePage {
  events: TraceEvent[];
  /** Events older than the returned tail. Zero when the file fits in the cap. */
  omittedEarlier: number;
}

function parseTraceFile(raw: string): TraceEvent[] {
  const lines = raw
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      /* skip bad line */
    }
  }
  return events;
}

export async function readSessionTracePage(
  stateDir: string,
  sessionId: string,
  limit = 500
): Promise<SessionTracePage> {
  const path = join(stateDir, 'traces', sessionId, 'events.jsonl');
  try {
    const events = parseTraceFile(await readFile(path, 'utf8'));
    const cap = Math.min(Math.max(limit, 1), SESSION_TRACE_READ_MAX);
    const omittedEarlier = Math.max(0, events.length - cap);
    return { events: events.slice(-cap), omittedEarlier };
  } catch {
    return { events: [], omittedEarlier: 0 };
  }
}

export async function readSessionTraceEvents(
  stateDir: string,
  sessionId: string,
  limit = 500
): Promise<TraceEvent[]> {
  return (await readSessionTracePage(stateDir, sessionId, limit)).events;
}
