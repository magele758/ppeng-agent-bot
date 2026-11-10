/**
 * Multi-signal risk engine (zero LLM) — absorb subset of ai-agent-node RiskEngine.
 * Consumes LoopGuard-like signals + tool error streaks; decides whether to enqueue advisory.
 */

import { envBool, envInt } from '../helpers.js';

export type RiskSignalType =
  | 'tool_repeat'
  | 'output_repeat'
  | 'tool_error_streak'
  | 'iteration_near_limit'
  | 'budget_high';

export interface RiskSnapshot {
  type: RiskSignalType;
  magnitude: number;
  meta?: Record<string, unknown>;
}

export interface RiskTickResult {
  shouldAdvise: boolean;
  signals: RiskSnapshot[];
  reason?: string;
}

export interface RiskEngineConfig {
  toolErrorStreakThreshold: number;
  iterationNearLimitGap: number;
  budgetHighRatio: number;
  maxCoachPerSession: number;
  coachCooldownIters: number;
  userQuietWindowIters: number;
}

export const DEFAULT_RISK_CONFIG: RiskEngineConfig = {
  toolErrorStreakThreshold: 3,
  iterationNearLimitGap: 2,
  budgetHighRatio: 0.85,
  maxCoachPerSession: 3,
  coachCooldownIters: 3,
  userQuietWindowIters: 2
};

export function riskEngineEnabled(env: Record<string, string | undefined>): boolean {
  return envBool(env, 'RAW_AGENT_RISK_ENGINE', true);
}

export function riskEngineConfigFromEnv(env: Record<string, string | undefined>): RiskEngineConfig {
  return {
    toolErrorStreakThreshold: envInt(env, 'RAW_AGENT_RISK_TOOL_ERROR_STREAK', 3),
    iterationNearLimitGap: envInt(env, 'RAW_AGENT_RISK_ITERATION_NEAR_GAP', 2),
    budgetHighRatio: (() => {
      const n = Number(env.RAW_AGENT_RISK_BUDGET_HIGH_RATIO);
      return Number.isFinite(n) ? Math.min(1, Math.max(0.5, n)) : 0.85;
    })(),
    maxCoachPerSession: envInt(env, 'RAW_AGENT_RISK_MAX_COACH', 3),
    coachCooldownIters: envInt(env, 'RAW_AGENT_RISK_COACH_COOLDOWN', 3),
    userQuietWindowIters: envInt(env, 'RAW_AGENT_RISK_USER_QUIET', 2)
  };
}

export class RiskEngine {
  private readonly config: RiskEngineConfig;
  private coachTriggered = 0;
  private lastCoachIter = -1_000_000;
  private lastUserInterventionIter = -1_000_000;
  private currentErrorBucket: { errorSignature: string; count: number } | null = null;

  constructor(config: Partial<RiskEngineConfig> = {}) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
  }

  reset(): void {
    this.coachTriggered = 0;
    this.lastCoachIter = -1_000_000;
    this.lastUserInterventionIter = -1_000_000;
    this.currentErrorBucket = null;
  }

  noteUserIntervention(iteration: number): void {
    this.lastUserInterventionIter = iteration;
  }

  observeTool(input: { toolName: string; success: boolean; errorMessage?: string }): void {
    if (input.success) {
      this.currentErrorBucket = null;
      return;
    }
    const sig = `${input.toolName}::${(input.errorMessage ?? '').slice(0, 80)}`;
    if (this.currentErrorBucket?.errorSignature === sig) {
      this.currentErrorBucket.count++;
    } else {
      this.currentErrorBucket = { errorSignature: sig, count: 1 };
    }
  }

  tick(input: {
    iteration: number;
    iterationLimit: number;
    sameToolStreak?: number;
    sameToolThreshold?: number;
    outputRepeatRatio?: number;
    outputRepeatThreshold?: number;
    usedTokens?: number;
    budgetTokens?: number;
  }): RiskTickResult {
    const signals: RiskSnapshot[] = [];

    if (
      typeof input.sameToolStreak === 'number' &&
      typeof input.sameToolThreshold === 'number' &&
      input.sameToolStreak >= input.sameToolThreshold
    ) {
      signals.push({
        type: 'tool_repeat',
        magnitude: input.sameToolStreak,
        meta: { streak: input.sameToolStreak }
      });
    }

    if (
      typeof input.outputRepeatRatio === 'number' &&
      typeof input.outputRepeatThreshold === 'number' &&
      input.outputRepeatRatio >= input.outputRepeatThreshold
    ) {
      signals.push({
        type: 'output_repeat',
        magnitude: input.outputRepeatRatio,
        meta: { ratio: input.outputRepeatRatio }
      });
    }

    if (
      this.currentErrorBucket &&
      this.currentErrorBucket.count >= this.config.toolErrorStreakThreshold
    ) {
      signals.push({
        type: 'tool_error_streak',
        magnitude: this.currentErrorBucket.count,
        meta: { signature: this.currentErrorBucket.errorSignature }
      });
    }

    const remaining = input.iterationLimit - input.iteration;
    if (remaining <= this.config.iterationNearLimitGap) {
      signals.push({
        type: 'iteration_near_limit',
        magnitude: remaining,
        meta: { iteration: input.iteration, limit: input.iterationLimit }
      });
    }

    if (
      typeof input.usedTokens === 'number' &&
      typeof input.budgetTokens === 'number' &&
      input.budgetTokens > 0 &&
      input.usedTokens / input.budgetTokens >= this.config.budgetHighRatio
    ) {
      signals.push({
        type: 'budget_high',
        magnitude: input.usedTokens / input.budgetTokens,
        meta: { used: input.usedTokens, budget: input.budgetTokens }
      });
    }

    if (signals.length === 0) {
      return { shouldAdvise: false, signals };
    }

    const inQuiet =
      input.iteration - this.lastUserInterventionIter < this.config.userQuietWindowIters;
    const inCooldown = input.iteration - this.lastCoachIter < this.config.coachCooldownIters;
    const overBudget = this.coachTriggered >= this.config.maxCoachPerSession;

    if (inQuiet || inCooldown || overBudget) {
      return {
        shouldAdvise: false,
        signals,
        reason: inQuiet ? 'user_quiet' : inCooldown ? 'cooldown' : 'max_coach'
      };
    }

    this.coachTriggered += 1;
    this.lastCoachIter = input.iteration;
    return {
      shouldAdvise: true,
      signals,
      reason: signals.map((s) => s.type).join(',')
    };
  }
}

export function formatRiskAdvisory(signals: RiskSnapshot[]): string {
  const lines = signals.map((s) => `- ${s.type} (magnitude=${s.magnitude})`);
  return (
    `[risk-advisory]\n` +
    `Risk signals detected:\n${lines.join('\n')}\n` +
    `Change strategy first: try a different tool, different input, or smaller steps. Ask the user only when the blocker is something only they can resolve. Avoid repeating the failing pattern.`
  ).slice(0, 600);
}
