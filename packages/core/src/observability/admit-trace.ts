/**
 * Admit-slice traces. Payload is phase, scope, and duration only.
 * A throwing emitter must not fail the turn.
 */
export interface AdmitStartupEvent {
  kind: 'startup_phase';
  payload: { phase: string; scope: 'admit'; durationMs: number };
}

export function admitStartupEvent(phase: string, durationMs: number): AdmitStartupEvent {
  return {
    kind: 'startup_phase',
    payload: { phase, scope: 'admit', durationMs: Math.max(0, Math.round(durationMs)) }
  };
}

export function emitAdmitPhase(
  emit: (event: AdmitStartupEvent) => void,
  phase: string,
  started: number
): void {
  try {
    emit(admitStartupEvent(phase, Date.now() - started));
  } catch {
    /* tracing must not fail the turn */
  }
}
