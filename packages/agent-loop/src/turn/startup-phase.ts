/**
 * Kernel startup slices. Agent-loop cannot import core, so this mirrors the
 * payload rules: phase, scope, durations, and counts only.
 * A throwing emitter must not fail the turn.
 */

export type KernelStartupScope = 'boot' | 'admit' | 'kernel' | 'prepare' | 'prompt' | 'mcp' | 'wake';

export interface KernelStartupFields {
  phase: string;
  scope: KernelStartupScope;
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

export interface KernelStartupTrace {
  sessionId: string;
  startedAt: number;
  phases: Record<string, number>;
  readySent: boolean;
  emitTrace?: (sessionId: string, event: { kind: string; data?: Record<string, unknown>; payload?: Record<string, unknown> }) => void;
}

const PHASE_NAME = /^[a-z0-9_]+$/;

export function createKernelStartupTrace(
  sessionId: string,
  emitTrace: KernelStartupTrace['emitTrace'],
  startedAt = Date.now()
): KernelStartupTrace {
  return { sessionId, startedAt, phases: {}, readySent: false, emitTrace };
}

export function sanitizeKernelStartupPhase(payload: KernelStartupFields): KernelStartupFields {
  const out: KernelStartupFields = {
    phase: payload.phase,
    scope: payload.scope,
    durationMs: Math.max(0, Math.round(payload.durationMs)),
  };
  for (const key of ['turn', 'messageCount', 'toolCount', 'skillCount', 'endpointCount', 'slowestMs'] as const) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.round(value);
  }
  if (typeof payload.slowest === 'string' && PHASE_NAME.test(payload.slowest)) out.slowest = payload.slowest;
  if (payload.phases && typeof payload.phases === 'object') {
    const phases: Record<string, number> = {};
    for (const [name, ms] of Object.entries(payload.phases)) {
      if (PHASE_NAME.test(name) && typeof ms === 'number' && Number.isFinite(ms)) {
        phases[name] = Math.max(0, Math.round(ms));
      }
    }
    out.phases = phases;
  }
  return out;
}

export function emitKernelStartupPhase(trace: KernelStartupTrace, payload: KernelStartupFields): void {
  try {
    const fields: Record<string, unknown> = { ...sanitizeKernelStartupPhase(payload) };
    trace.emitTrace?.(trace.sessionId, { kind: 'startup_phase', data: fields, payload: fields });
  } catch {
    /* tracing must not fail the turn */
  }
}

function remember(trace: KernelStartupTrace, phase: string, durationMs: number): number {
  const ms = Math.max(0, Math.round(durationMs));
  if (!trace.readySent) trace.phases[phase] = ms;
  return ms;
}

function recordPhase(
  trace: KernelStartupTrace,
  phase: string,
  durationMs: number,
  extra?: Partial<KernelStartupFields>
): void {
  if (trace.readySent) return;
  const ms = remember(trace, phase, durationMs);
  emitKernelStartupPhase(trace, { phase, scope: 'kernel', turn: 0, ...extra, durationMs: ms });
}

/** Times a required slice. Recording stops after `ready` so later turns are not startup. */
export async function timeKernelPhase<T>(
  trace: KernelStartupTrace,
  phase: string,
  run: () => Promise<T> | T,
  extra?: Partial<KernelStartupFields>
): Promise<T> {
  if (trace.readySent) return await run();
  const started = Date.now();
  try {
    return await run();
  } finally {
    recordPhase(trace, phase, Date.now() - started, extra);
  }
}

/** Records 0 when the optional host method is missing, otherwise times the call. */
export async function timeOptionalKernelPhase<T>(
  trace: KernelStartupTrace,
  phase: string,
  run: (() => Promise<T> | T) | undefined,
  extra?: Partial<KernelStartupFields>
): Promise<T | undefined> {
  if (!run) {
    recordPhase(trace, phase, 0, extra);
    return undefined;
  }
  return timeKernelPhase(trace, phase, run, extra);
}

function slowestKernelPhase(phases: Record<string, number>): { slowest?: string; slowestMs: number } {
  let slowest: string | undefined;
  let slowestMs = -1;
  for (const [name, ms] of Object.entries(phases)) {
    if (name === 'ready') continue;
    if (ms >= slowestMs) {
      slowest = name;
      slowestMs = ms;
    }
  }
  return { slowest, slowestMs };
}

/** One summary per run. Later calls are no-ops so model time is not included. */
export function emitKernelReady(trace: KernelStartupTrace): void {
  if (trace.readySent) return;
  const found = slowestKernelPhase(trace.phases);
  const slowest = found.slowest;
  const slowestMs = found.slowestMs;
  trace.readySent = true;
  emitKernelStartupPhase(trace, {
    phase: 'ready',
    scope: 'kernel',
    durationMs: Date.now() - trace.startedAt,
    turn: 0,
    slowest,
    slowestMs: slowestMs < 0 ? 0 : slowestMs,
    phases: { ...trace.phases },
  });
}
