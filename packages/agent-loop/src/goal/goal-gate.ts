/**
 * Soft completion gate: after a normal (non-tool) turn, ask a text judge whether
 * `goalCondition` is met. Fail-open on judge errors (trust main loop stop).
 */

import { envBool, envInt } from '../helpers.js';
import { decideGoalTurn } from './decide-goal-turn.js';
import { parseGoalEvalJson } from './parse-goal-eval.js';
import type { GoalEvalResult, GoalLedgerEntry, GoalTurnDecision } from './types.js';
import {
  GOAL_CONDITION_META,
  GOAL_ENABLED_META,
  GOAL_LEDGER_META,
  GOAL_MAX_TURNS_META,
  GOAL_TURNS_USED_META
} from './types.js';

export type GoalJudgeFn = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

export function goalGateEnabled(env: NodeJS.ProcessEnv): boolean {
  return envBool(env, 'RAW_AGENT_GOAL_GATE', true);
}

export function defaultGoalMaxTurns(env: NodeJS.ProcessEnv): number {
  const raw = env.RAW_AGENT_GOAL_MAX_TURNS;
  if (raw == null || String(raw).trim() === '') return 0;
  const n = envInt(env, 'RAW_AGENT_GOAL_MAX_TURNS', 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.floor(n));
}

export function resolveGoalCondition(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const enabled = metadata[GOAL_ENABLED_META];
  const cond = metadata[GOAL_CONDITION_META];
  if (typeof cond === 'string' && cond.trim()) return cond.trim();
  if (enabled === true || enabled === 1 || enabled === '1' || enabled === 'true') {
    return typeof cond === 'string' && cond.trim() ? cond.trim() : undefined;
  }
  return undefined;
}

export function readGoalLedger(metadata: Record<string, unknown> | undefined): GoalLedgerEntry[] {
  const raw = metadata?.[GOAL_LEDGER_META];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is GoalLedgerEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as GoalLedgerEntry).turn === 'number' &&
      typeof (e as GoalLedgerEntry).met === 'boolean' &&
      typeof (e as GoalLedgerEntry).reason === 'string'
  );
}

const JUDGE_SYSTEM = `You are a goal completion judge. Given a goal condition and a conversation snapshot, decide if the goal is met based ONLY on what is already surfaced in the dialogue (do not call tools).
Return JSON only: {"met":boolean,"reason":string,"progress":"advanced"|"stalled"(optional),"missing":string[](optional),"missing_kind":"user"|"tool"|"unknown"(optional)}.
Rules:
- met=true only when the snapshot contains concrete evidence that the condition is satisfied.
- If the condition includes constraints/scope limits that were violated, met=false.
- If unsure or the snapshot is insufficient, met=false with a short reason.`;

export class GoalGate {
  private readonly condition: string;
  private readonly maxTurns: number;
  private turnsUsed: number;
  private ledger: GoalLedgerEntry[];

  constructor(opts: {
    condition: string;
    maxTurns: number;
    initialTurns?: number;
    ledger?: GoalLedgerEntry[];
  }) {
    this.condition = opts.condition;
    this.maxTurns = opts.maxTurns;
    this.turnsUsed = opts.initialTurns ?? 0;
    this.ledger = opts.ledger ? [...opts.ledger] : [];
  }

  isActive(): boolean {
    return this.condition.length > 0;
  }

  getTurnsUsed(): number {
    return this.turnsUsed;
  }

  getLedger(): GoalLedgerEntry[] {
    return [...this.ledger];
  }

  metadataPatch(): Record<string, unknown> {
    return {
      [GOAL_CONDITION_META]: this.condition,
      [GOAL_MAX_TURNS_META]: this.maxTurns,
      [GOAL_TURNS_USED_META]: this.turnsUsed,
      [GOAL_LEDGER_META]: this.ledger,
      [GOAL_ENABLED_META]: true
    };
  }

  async evaluate(opts: {
    snapshot: string;
    judge: GoalJudgeFn;
    signal?: AbortSignal;
    steerTexts?: string[];
    /** Host-run verify. Failure is fail-closed and skips the judge. */
    verify?: () => Promise<{ ok: boolean; reason: string }>;
  }): Promise<{ evalResult: GoalEvalResult; decision: GoalTurnDecision }> {
    this.turnsUsed += 1;
    let evalResult: GoalEvalResult;

    if (opts.verify) {
      try {
        const v = await opts.verify();
        if (!v.ok) {
          evalResult = { met: false, reason: v.reason, source: 'verify-failed' };
          return this.finishEval(evalResult, opts.steerTexts ?? []);
        }
      } catch (err) {
        evalResult = {
          met: false,
          reason: `verify error; fail-closed: ${err instanceof Error ? err.message : String(err)}`,
          source: 'verify-failed'
        };
        return this.finishEval(evalResult, opts.steerTexts ?? []);
      }
    }

    try {
      const raw = await opts.judge({
        system: JUDGE_SYSTEM,
        user: [
          `Goal condition:\n${this.condition}`,
          this.ledger.length
            ? `Prior judgments (bounded):\n${this.ledger
                .slice(-5)
                .map((e) => `- turn ${e.turn}: met=${e.met} progress=${e.progress ?? '?'} — ${e.reason}`)
                .join('\n')}`
            : '',
          `Conversation snapshot:\n${opts.snapshot.slice(0, 12_000)}`
        ]
          .filter(Boolean)
          .join('\n\n'),
        signal: opts.signal
      });
      const parsed = parseGoalEvalJson(raw);
      if (!parsed) {
        evalResult = {
          met: true,
          reason: 'judge parse failed; fail-open',
          source: 'fail-open-parse'
        };
      } else {
        evalResult = { ...parsed, source: 'model' };
      }
    } catch (err) {
      evalResult = {
        met: true,
        reason: `judge error; fail-open: ${err instanceof Error ? err.message : String(err)}`,
        source: 'fail-open-error'
      };
    }

    return this.finishEval(evalResult, opts.steerTexts ?? []);
  }

  private finishEval(
    evalResult: GoalEvalResult,
    steerTexts: string[]
  ): { evalResult: GoalEvalResult; decision: GoalTurnDecision } {
    const decision = decideGoalTurn({
      evalResult,
      steerTexts,
      ledger: this.ledger,
      turnsUsed: this.turnsUsed,
      maxTurns: this.maxTurns
    });

    this.ledger.push({
      turn: this.turnsUsed,
      met: evalResult.met,
      reason: evalResult.reason,
      progress: evalResult.progress,
      missingKind: evalResult.missingKind,
      at: new Date().toISOString()
    });
    if (this.ledger.length > 40) this.ledger = this.ledger.slice(-40);

    return { evalResult, decision };
  }
}

export function createGoalGateFromMetadata(
  metadata: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv
): GoalGate | null {
  if (!goalGateEnabled(env)) return null;
  const condition = resolveGoalCondition(metadata);
  if (!condition) return null;
  const capOn = metadata?.goalTurnCapEnabled === true;
  const maxTurnsRaw = metadata?.[GOAL_MAX_TURNS_META];
  const maxTurns =
    capOn && typeof maxTurnsRaw === 'number' && maxTurnsRaw > 0
      ? Math.min(100, Math.floor(maxTurnsRaw))
      : defaultGoalMaxTurns(env);
  const turnsRaw = metadata?.[GOAL_TURNS_USED_META];
  const initialTurns = typeof turnsRaw === 'number' && turnsRaw >= 0 ? Math.floor(turnsRaw) : 0;
  return new GoalGate({
    condition,
    maxTurns,
    initialTurns,
    ledger: readGoalLedger(metadata)
  });
}
