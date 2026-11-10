/**
 * Timed slices for bot startup. Payload is phase name, scope, and durations
 * or counts only — never message text, prompts, tool args, URLs, or secrets.
 * Tracing must not fail the start.
 */
import { createLogger } from '../logger.js';

const log = createLogger('bot-startup');

export type StartupScope = 'boot' | 'admit' | 'kernel' | 'prepare' | 'prompt' | 'mcp' | 'wake';

export interface StartupPhasePayload {
  phase: string;
  scope: StartupScope;
  durationMs: number;
  turn?: number;
  messageCount?: number;
  toolCount?: number;
  skillCount?: number;
  endpointCount?: number;
  slowest?: string;
  slowestMs?: number;
  phases?: Record<string, number>;
}

type Emitter = (
  sessionId: string,
  event: { kind: 'startup_phase'; payload: StartupPhasePayload }
) => void;

let emitter: Emitter | undefined;

export function setStartupPhaseEmitter(next: Emitter | undefined): void {
  emitter = next;
}

export function sanitizeStartupPhase(payload: StartupPhasePayload): StartupPhasePayload {
  const out: StartupPhasePayload = {
    phase: payload.phase,
    scope: payload.scope,
    durationMs: Math.max(0, Math.round(payload.durationMs))
  };
  for (const key of ['turn', 'messageCount', 'toolCount', 'skillCount', 'endpointCount', 'slowestMs'] as const) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.round(value);
  }
  if (typeof payload.slowest === 'string' && /^[a-z0-9_]+$/.test(payload.slowest)) out.slowest = payload.slowest;
  if (payload.phases && typeof payload.phases === 'object') {
    const phases: Record<string, number> = {};
    for (const [name, ms] of Object.entries(payload.phases)) {
      if (/^[a-z0-9_]+$/.test(name) && typeof ms === 'number' && Number.isFinite(ms)) {
        phases[name] = Math.max(0, Math.round(ms));
      }
    }
    out.phases = phases;
  }
  return out;
}

function isStartupScope(value: string): value is StartupScope {
  return value === 'boot' || value === 'admit' || value === 'kernel' || value === 'prepare' || value === 'prompt' || value === 'mcp' || value === 'wake';
}

export function startupPhaseFromRecord(raw: Record<string, unknown>): StartupPhasePayload | undefined {
  if (typeof raw.phase !== 'string' || typeof raw.durationMs !== 'number' || typeof raw.scope !== 'string' || !isStartupScope(raw.scope)) return undefined;
  const payload: StartupPhasePayload = { phase: raw.phase, scope: raw.scope as StartupScope, durationMs: raw.durationMs };
  for (const key of ['turn', 'messageCount', 'toolCount', 'skillCount', 'endpointCount', 'slowestMs'] as const) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) payload[key] = value;
  }
  if (typeof raw.slowest === 'string') payload.slowest = raw.slowest;
  if (raw.phases && typeof raw.phases === 'object' && !Array.isArray(raw.phases)) {
    const phases: Record<string, number> = {};
    for (const [name, ms] of Object.entries(raw.phases)) {
      if (typeof ms === 'number' && Number.isFinite(ms)) phases[name] = ms;
    }
    payload.phases = phases;
  }
  return sanitizeStartupPhase(payload);
}

/** Above this, every phase is recorded and warned. A ~1s ready stays under it. */
const SLOW_STARTUP_MS = 50_000;

/** Both kernels include these fast slices in the ready summary. Keep slow slices for live diagnosis. */
export function startupTraceDisposition(payload: StartupPhasePayload): 'summary' | 'detail' | 'warn' {
  if (payload.durationMs >= SLOW_STARTUP_MS) return 'warn';
  if (payload.scope !== 'kernel') return 'summary';
  if (payload.phase === 'ready') return 'detail';
  return payload.durationMs < 1000 ? 'summary' : 'detail';
}

const pendingOrdinaryPhases = new Map<string, Record<string, number>>();
const startupReadySent = new Set<string>();

/** A new run must not inherit the previous ready fold. */
export function resetStartupPhaseFold(sessionId: string): void {
  pendingOrdinaryPhases.delete(sessionId);
  startupReadySent.delete(sessionId);
}

function rememberOrdinaryPhase(sessionId: string, payload: StartupPhasePayload): void {
  if (!/^[a-z0-9_]+$/.test(payload.phase)) return;
  const phases = pendingOrdinaryPhases.get(sessionId) ?? {};
  phases[payload.phase] = Math.max(0, Math.round(payload.durationMs));
  pendingOrdinaryPhases.set(sessionId, phases);
}

function mergeOrdinaryPhases(sessionId: string, payload: Record<string, unknown>): void {
  const extra = pendingOrdinaryPhases.get(sessionId);
  pendingOrdinaryPhases.delete(sessionId);
  startupReadySent.add(sessionId);
  if (!extra) return;
  const phases: Record<string, number> = {};
  const existing = payload.phases;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [name, ms] of Object.entries(existing as Record<string, unknown>)) {
      if (/^[a-z0-9_]+$/.test(name) && typeof ms === 'number' && Number.isFinite(ms)) {
        phases[name] = Math.max(0, Math.round(ms));
      }
    }
  }
  for (const [name, ms] of Object.entries(extra)) {
    if (!(name in phases)) phases[name] = ms;
  }
  payload.phases = phases;
}

/**
 * Log every phase. Kernel slices already live inside ready.phases, so their
 * individual lines stay omitted. Other short phases are debug plus one ready
 * summary. Slow phases and a ~1s ready are not dropped.
 * Returns true when the individual event must not be appended.
 */
export function foldStartupPhase(sessionId: string, payload: Record<string, unknown>): boolean {
  const startup = startupPhaseFromRecord(payload);
  if (!startup) return false;
  logStartupPhase(sessionId, startup);
  if (startup.scope === 'kernel' && startup.phase === 'ready') {
    mergeOrdinaryPhases(sessionId, payload);
    return false;
  }
  if (startupTraceDisposition(startup) !== 'summary') return false;
  if (startup.scope === 'kernel') return true;
  if (startupReadySent.has(sessionId)) return false;
  rememberOrdinaryPhase(sessionId, startup);
  return true;
}

/** Boot lines only. Ordinary phases under the slow threshold are debug; slow phases warn. */
export function logStartupPhase(sessionId: string | undefined, payload: StartupPhasePayload): void {
  try {
    const clean = sanitizeStartupPhase(payload);
    const disposition = startupTraceDisposition(clean);
    if (disposition === 'warn') {
      log.warn('bot_startup_slow', { sessionId, ...clean });
      return;
    }
    if (clean.scope === 'boot') {
      log.info('bot_startup', sessionId ? { sessionId, ...clean } : clean);
      return;
    }
    log.debug('bot_startup', sessionId ? { sessionId, ...clean } : clean);
  } catch {
    /* tracing must not fail startup */
  }
}

/** Session trace via the emitter registered by the runtime. Does not log. */
export function emitStartupPhase(sessionId: string, payload: StartupPhasePayload): void {
  if (!emitter) return;
  try {
    emitter(sessionId, { kind: 'startup_phase', payload: sanitizeStartupPhase(payload) });
  } catch {
    /* tracing must not fail startup */
  }
}

export async function timeStartupPhase<T>(
  sessionId: string | undefined,
  phase: string,
  scope: StartupScope,
  run: () => Promise<T> | T,
  extra?: Partial<StartupPhasePayload>
): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    const payload = { phase, scope, durationMs: Date.now() - started, ...extra };
    if (sessionId) emitStartupPhase(sessionId, payload);
    else logStartupPhase(undefined, payload);
  }
}
