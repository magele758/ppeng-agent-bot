import type { GoalEvalResult, GoalRecord, GoalTurnDecision } from './types.js';
import {
  GOAL_CONDITION_META,
  GOAL_ENABLED_META,
  GOAL_MAX_TURNS_META
} from './types.js';
import { createGoalRecord, GoalStore } from './goal-store.js';
import { decisionToGoalEvent } from './goal-state-machine.js';
import type { GoalGate } from './goal-gate.js';
import { resolveGoalCondition } from './goal-gate.js';
import { parseGoalVerifySpec, sanitizeDerivedVerifySpec } from './verify-spec.js';
import { readGoalSettings, type GoalSettingsStore } from './settings.js';

function defaultMaxTurns(metadata: Record<string, unknown> | undefined, fallback: number): number {
  const raw = metadata?.[GOAL_MAX_TURNS_META];
  if (typeof raw === 'number' && raw > 0) return Math.max(1, Math.min(100, Math.floor(raw)));
  return fallback;
}

export function ensureGoalEntityFromMetadata(
  store: GoalStore,
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  settingsStore?: GoalSettingsStore
): GoalRecord | null {
  const settings = settingsStore ? readGoalSettings(settingsStore) : undefined;
  if (settings && settings.entityEnabled === false) {
    return store.findLatestBySession(sessionId);
  }
  const condition = resolveGoalCondition(metadata);
  if (!condition) return store.findLatestBySession(sessionId);
  const maxTurns = defaultMaxTurns(metadata, settings?.defaultMaxTurns ?? 0);
  const latest = store.findLatestBySession(sessionId);
  if (
    latest &&
    (latest.status === 'active' || latest.status === 'deriving' || latest.status === 'waiting_user') &&
    latest.condition === condition
  ) {
    return latest;
  }
  if (latest && (latest.status === 'active' || latest.status === 'deriving')) {
    try {
      store.commitTransition(latest, 'aborted');
    } catch {
      /* fail-soft */
    }
  }
  const verifyRaw = (metadata as { goalVerify?: unknown } | undefined)?.goalVerify;
  const verify =
    parseGoalVerifySpec(verifyRaw) ?? sanitizeDerivedVerifySpec(verifyRaw) ?? undefined;
  const rec = createGoalRecord({
    sessionId,
    status: 'active',
    spec: {
      goal: condition,
      criteria: [],
      source: 'explicit',
      ...(verify ? { verify } : {})
    },
    condition,
    maxTurns
  });
  store.upsert(rec);
  return rec;
}

export function persistGoalAfterEval(input: {
  store: GoalStore;
  sessionId: string;
  metadata?: Record<string, unknown>;
  evalResult: GoalEvalResult;
  decision: GoalTurnDecision;
  gate: GoalGate;
}): GoalRecord | null {
  try {
    let rec = input.store.findLatestBySession(input.sessionId);
    if (!rec) {
      rec = ensureGoalEntityFromMetadata(input.store, input.sessionId, input.metadata);
    }
    if (!rec) return null;
    if (rec.status === 'waiting_user') {
      rec = input.store.commitTransition(rec, 'user_reply');
    }
    if (rec.status !== 'active' && rec.status !== 'deriving') return rec;
    const event = decisionToGoalEvent(input.decision);
    return input.store.commitTransition(rec, event, {
      turnsUsed: input.gate.getTurnsUsed(),
      ledger: input.gate.getLedger(),
      missing: input.evalResult.missing
    });
  } catch {
    return null;
  }
}

export function markGoalWaitingUser(store: GoalStore | null, sessionId: string): GoalRecord | null {
  if (!store) return null;
  try {
    const rec = store.findLatestBySession(sessionId);
    if (!rec || rec.status !== 'active') return rec;
    return store.commitTransition(rec, 'need_user');
  } catch {
    return null;
  }
}

export function resumeGoalOnUserReply(store: GoalStore | null, sessionId: string): GoalRecord | null {
  if (!store) return null;
  try {
    const rec = store.findLatestBySession(sessionId);
    if (!rec || rec.status !== 'waiting_user') return rec;
    return store.commitTransition(rec, 'user_reply');
  } catch {
    return null;
  }
}

export function upsertGoalFromApi(
  store: GoalStore,
  input: {
    sessionId: string;
    condition: string;
    maxTurns?: number;
    verify?: unknown;
    criteria?: string[];
  }
): GoalRecord {
  const latest = store.findLatestBySession(input.sessionId);
  if (latest && (latest.status === 'active' || latest.status === 'deriving')) {
    try {
      store.commitTransition(latest, 'aborted');
    } catch {
      /* ignore */
    }
  }
  const verify = parseGoalVerifySpec(input.verify);
  const rec = createGoalRecord({
    sessionId: input.sessionId,
    status: 'active',
    spec: {
      goal: input.condition,
      criteria: input.criteria ?? [],
      source: 'explicit',
      ...(verify ? { verify } : {})
    },
    condition: input.condition,
    maxTurns: input.maxTurns ?? 25
  });
  store.upsert(rec);
  return rec;
}

export function goalWirePayload(rec: GoalRecord | null): Record<string, unknown> | null {
  if (!rec) return null;
  return {
    goalId: rec.goalId,
    sessionId: rec.sessionId,
    status: rec.status,
    closeReason: rec.closeReason,
    condition: rec.condition,
    turnsUsed: rec.turnsUsed,
    maxTurns: rec.maxTurns,
    missing: rec.missing,
    spec: {
      goal: rec.spec.goal,
      criteria: rec.spec.criteria,
      source: rec.spec.source,
      verify: rec.spec.verify
        ? { kind: rec.spec.verify.kind, paths: rec.spec.verify.paths, url: rec.spec.verify.url }
        : undefined
    },
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt
  };
}

export function sessionMetadataFromGoal(rec: GoalRecord): Record<string, unknown> {
  return {
    [GOAL_CONDITION_META]: rec.condition,
    [GOAL_ENABLED_META]: true,
    [GOAL_MAX_TURNS_META]: rec.maxTurns,
    ...(rec.maxTurns > 0 ? { goalTurnCapEnabled: true } : {})
  };
}
