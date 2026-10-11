/**
 * Single internal switch for the Evolution product surface.
 *
 * Default off: the Lab does not show Evolution, and nothing in the product
 * starts a run (boot, scheduler tick, HTTP, CLI, cron wrapper).
 * Flip this constant to surface it again. Not an environment variable,
 * and there is no settings toggle.
 */
export const EVOLUTION_SURFACE_ENABLED = false;

export const EVOLUTION_DISABLED_CODE = 'evolution_disabled' as const;

export type EvolutionScheduleReason = 'boot' | 'timer' | 'http' | 'cli';

export interface EvolutionScheduleDecision {
  started: boolean;
  code: typeof EVOLUTION_DISABLED_CODE | 'ok';
}

export function evolutionDisabledBody(): {
  error: string;
  code: typeof EVOLUTION_DISABLED_CODE;
} {
  return {
    error: 'Evolution is disabled',
    code: EVOLUTION_DISABLED_CODE
  };
}

/**
 * The only decision point that may launch an Evolution run.
 * While the switch is off, `launch` is not called.
 */
export function considerEvolutionSchedule(input?: {
  reason?: EvolutionScheduleReason;
  launch?: (reason: EvolutionScheduleReason) => void;
}): EvolutionScheduleDecision {
  const reason = input?.reason ?? 'timer';
  if (!EVOLUTION_SURFACE_ENABLED) {
    return { started: false, code: EVOLUTION_DISABLED_CODE };
  }
  input?.launch?.(reason);
  return { started: true, code: 'ok' };
}

/**
 * Inbound HTTP that would start a run.
 * Always 409: the switch refuses the job, and this process has no Evolution launcher.
 */
export function evolutionStartHttpResult(): {
  status: 409;
  body: ReturnType<typeof evolutionDisabledBody>;
} {
  considerEvolutionSchedule({ reason: 'http' });
  return { status: 409, body: evolutionDisabledBody() };
}
