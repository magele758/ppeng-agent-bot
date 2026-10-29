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

/** Boot lines only. Per-turn phases stay in the session trace. */
export function logStartupPhase(sessionId: string | undefined, payload: StartupPhasePayload): void {
  try {
    const clean = sanitizeStartupPhase(payload);
    if (clean.scope !== 'boot') return;
    log.info('bot_startup', sessionId ? { sessionId, ...clean } : clean);
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
