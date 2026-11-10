/**
 * One-shot advisory grace before a hard recovery abort.
 *
 * When SessionLoopGuard (or similar) would abort, the first hit injects an
 * advisory and lets the loop continue one more turn — lighter cousin of
 * ai-agent-node RiskEngine → AdvisoryInjector.
 */

import { envBool } from '../helpers.js';

export function advisoryGraceEnabled(env: Record<string, string | undefined>): boolean {
  return envBool(env, 'RAW_AGENT_RECOVERY_ADVISORY_GRACE', true);
}

/** Budget of soft advisories before hard abort; 0 disables grace (allows explicit zero). */
export function advisoryGraceBudget(env: Record<string, string | undefined>): number {
  const raw = env.RAW_AGENT_RECOVERY_ADVISORY_GRACE_BUDGET;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(5, Math.floor(n)));
}

export type GuardDecision = { abort: true; reason: string } | { abort: false; reason?: string };

export type GraceOutcome =
  | { action: 'continue' }
  | { action: 'advise'; reason: string; advisory: string }
  | { action: 'abort'; reason: string };

/**
 * Per-run grace counter. Construct once per `runSession`.
 */
export class AdvisoryGrace {
  private remaining: number;

  constructor(budget: number) {
    this.remaining = Math.max(0, budget);
  }

  get remainingBudget(): number {
    return this.remaining;
  }

  /**
   * Map a guard decision through grace:
   * - no abort → continue
   * - abort + budget left → consume 1, return advise
   * - abort + budget exhausted → abort
   */
  apply(decision: GuardDecision): GraceOutcome {
    if (!decision.abort) return { action: 'continue' };
    if (this.remaining > 0) {
      this.remaining -= 1;
      return {
        action: 'advise',
        reason: decision.reason,
        advisory: formatRecoveryAdvisory(decision.reason)
      };
    }
    return { action: 'abort', reason: decision.reason };
  }
}

export function formatRecoveryAdvisory(reason: string): string {
  return (
    `[recovery-advisory] Loop risk detected (${reason}). ` +
    `You have one more chance: change strategy first (different tool, different input, or a smaller step). ` +
    `Ask the user only when the blocker is something only they can resolve. ` +
    `Repeating the same failing pattern will stop the run.`
  );
}
