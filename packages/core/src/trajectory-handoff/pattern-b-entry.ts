/**
 * Independent Pattern B isolation switch.
 * Default off. Knife-3 and knife-4 entry flags do not open it.
 * A flywheel task is admitted only when this switch is on and the host
 * qualifies the role. Explicit off wins. This is not PATTERN_B_PRODUCTION_ENTRY.
 */
export const PATTERN_B_ISOLATION_CONTROL_KEY = 'trajectory-handoff.pattern-b-isolation';
export const PATTERN_B_ISOLATION_RECORDS_KEY = 'trajectory-handoff.pattern-b-isolation-records';
export const PATTERN_B_ISOLATION_TASK_TAG = 'pattern-b-isolation';

/** Tag the flywheel implement task only when Pattern B admission is open. */
export function patternBImplementTask(title: string, isolationEnabled: boolean): {
  title: string;
  requiredRole: 'implementer';
  capabilityTags?: string[];
} {
  if (isolationEnabled !== true) return { title, requiredRole: 'implementer' };
  return { title, requiredRole: 'implementer', capabilityTags: [PATTERN_B_ISOLATION_TASK_TAG] };
}
export interface PatternBTrustedContext {
  readonly source?: unknown;
  readonly orchestrationRunId?: string | null;
  readonly patternBEnabled?: boolean;
  readonly patternBExplicitOff?: boolean;
  readonly patternBHostEnforced?: boolean;
  readonly patternBCanonicalizer?: boolean;
  readonly isolationTask?: boolean;
  readonly flywheelImplement?: boolean;
  readonly flywheelPlanner?: boolean;
}

export interface PatternBSwitch {
  readonly enabled: boolean;
  readonly explicitOff: boolean;
}

export type PatternBRollbackMode = 'stop_new_admission' | 'cancel_in_flight';
export type PatternBInFlightPolicy = 'controlled_finish' | 'cancel';

export interface PatternBRollbackSwitch {
  readonly enabled: false;
  readonly explicitOff: true;
  readonly source: 'explicit_off';
  readonly inFlightPolicy: PatternBInFlightPolicy;
  readonly rollbackMode: PatternBRollbackMode;
  readonly retainUnintegrated: true;
  readonly copyToShared: false;
  readonly deleteUnconfirmed: false;
}

export interface PatternBIsolationRecord {
  readonly runId: string;
  readonly sessionId?: string;
  readonly workerId?: string;
  readonly isolationEnabled: true;
  readonly persistedAt: string;
  readonly unintegratedRetained: true;
}


export type PatternBDenyReason =
  | 'no_trusted_context'
  | 'explicit_off'
  | 'switch_off'
  | 'not_isolation_task'
  | 'flywheel_source'
  | 'flywheel_orchestration'
  | 'source_not_admitted'
  | 'not_enforced'
  | 'self_reported';

export type PatternBAdmission =
  | { readonly open: true; readonly source: 'independent_swarm' | 'flywheel' }
  | { readonly open: false; readonly reason: PatternBDenyReason };
function workerClaimsIsolation(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  return metadata.patternBEnabled === true
    || metadata.isolationEnabled === true
    || metadata.workerClaimsIsolation === true
    || metadata.workerClaimsSharedWrite === true
    || metadata.workerClaimsSkipGate === true
    || metadata.skipGate === true
    || metadata.writableSharedTarget === true
    || metadata.flywheelImplement === true
    || metadata.flywheelPlanner === true;
}

function flywheelMarked(trusted: PatternBTrustedContext): boolean {
  return trusted.source === 'flywheel'
    || (typeof trusted.orchestrationRunId === 'string' && trusted.orchestrationRunId.length > 0);
}

function flywheelHostQualified(trusted: PatternBTrustedContext): boolean {
  return trusted.patternBEnabled === true
    && trusted.isolationTask === true
    && (trusted.flywheelImplement === true || trusted.flywheelPlanner === true);
}

function sourceBlock(trusted: PatternBTrustedContext): PatternBDenyReason | undefined {
  if (!flywheelMarked(trusted)) {
    return trusted.source === 'independent_swarm' ? undefined : 'source_not_admitted';
  }
  if (trusted.patternBExplicitOff === true || flywheelHostQualified(trusted)) return undefined;
  return typeof trusted.orchestrationRunId === 'string' && trusted.orchestrationRunId.length > 0
    ? 'flywheel_orchestration'
    : 'flywheel_source';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function explicitOffValue(stored: unknown): boolean {
  if (stored === false || stored === 'off' || stored === 'explicit_off') return true;
  const record = asRecord(stored);
  if (!record) return false;
  return record.explicitOff === true || record.enabled === false || record.source === 'explicit_off';
}

function explicitOnValue(stored: unknown): boolean {
  if (stored === true || stored === 'on') return true;
  const record = asRecord(stored);
  return record?.enabled === true && record.explicitOff !== true && record.source !== 'explicit_off';
}

/** Missing is default off, not an explicit close. Illegal values fail closed. */
export function readPatternBIsolationSwitch(stored: unknown): PatternBSwitch {
  if (stored == null) return { enabled: false, explicitOff: false };
  if (explicitOffValue(stored)) return { enabled: false, explicitOff: true };
  if (explicitOnValue(stored)) return { enabled: true, explicitOff: false };
  return { enabled: false, explicitOff: true };
}

export function patternBInFlightPolicy(stored: unknown): PatternBInFlightPolicy {
  const record = asRecord(stored);
  return record?.inFlightPolicy === 'cancel' ? 'cancel' : 'controlled_finish';
}

export function rollbackPatternBIsolation(mode: PatternBRollbackMode): PatternBRollbackSwitch {
  return {
    enabled: false,
    explicitOff: true,
    source: 'explicit_off',
    inFlightPolicy: mode === 'cancel_in_flight' ? 'cancel' : 'controlled_finish',
    rollbackMode: mode,
    retainUnintegrated: true,
    copyToShared: false,
    deleteUnconfirmed: false,
  };
}

export function patternBNewAdmissionAllowed(stored: unknown): boolean {
  return readPatternBIsolationSwitch(stored).enabled === true;
}


function switchBlock(trusted: PatternBTrustedContext, claimed: boolean): PatternBDenyReason | undefined {
  if (trusted.patternBExplicitOff === true) return 'explicit_off';
  if (trusted.patternBEnabled !== true) return claimed ? 'self_reported' : 'switch_off';
  if (trusted.isolationTask !== true) return 'not_isolation_task';
  if (trusted.patternBHostEnforced !== true || trusted.patternBCanonicalizer !== true) return 'not_enforced';
  return undefined;
}

/** Worker metadata cannot open isolation or skip the gate. */
export function admitPatternBIsolation(input: {
  readonly trusted?: PatternBTrustedContext | null;
  readonly workerMetadata?: Record<string, unknown> | null;
}): PatternBAdmission {
  const claimed = workerClaimsIsolation(input.workerMetadata);
  const trusted = input.trusted;
  if (!trusted) return { open: false, reason: claimed ? 'self_reported' : 'no_trusted_context' };
  const blocked = sourceBlock(trusted) ?? switchBlock(trusted, claimed);
  if (blocked) return { open: false, reason: blocked };
  return { open: true, source: flywheelMarked(trusted) ? 'flywheel' : 'independent_swarm' };
}

export type PatternBRecordRead =
  | { readonly ok: true; readonly records: readonly PatternBIsolationRecord[] }
  | { readonly ok: false; readonly reason: 'unreadable' };

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseIsolationRecord(value: unknown): PatternBIsolationRecord | undefined {
  const record = asRecord(value);
  if (!record || record.isolationEnabled !== true || record.unintegratedRetained !== true) return undefined;
  if (typeof record.runId !== 'string' || record.runId.length === 0) return undefined;
  if (typeof record.persistedAt !== 'string' || record.persistedAt.length === 0) return undefined;
  const parsed: PatternBIsolationRecord = {
    runId: record.runId,
    isolationEnabled: true,
    persistedAt: record.persistedAt,
    unintegratedRetained: true,
  };
  const sessionId = optionalId(record.sessionId);
  const workerId = optionalId(record.workerId);
  if (sessionId) return workerId ? { ...parsed, sessionId, workerId } : { ...parsed, sessionId };
  return workerId ? { ...parsed, workerId } : parsed;
}

export function readPatternBIsolationRecords(stored: unknown): PatternBRecordRead {
  if (stored == null) return { ok: true, records: [] };
  if (!Array.isArray(stored)) return { ok: false, reason: 'unreadable' };
  const records: PatternBIsolationRecord[] = [];
  for (const item of stored) {
    const parsed = parseIsolationRecord(item);
    if (!parsed) return { ok: false, reason: 'unreadable' };
    records.push(parsed);
  }
  return { ok: true, records };
}

export function rememberPatternBIsolation(
  stored: unknown,
  incoming: { readonly runId: string; readonly sessionId?: string; readonly workerId?: string; readonly persistedAt: string },
): PatternBRecordRead {
  const current = readPatternBIsolationRecords(stored);
  if (!current.ok) return current;
  const next: PatternBIsolationRecord = {
    runId: incoming.runId,
    isolationEnabled: true,
    persistedAt: incoming.persistedAt,
    unintegratedRetained: true,
    ...(incoming.sessionId ? { sessionId: incoming.sessionId } : {}),
    ...(incoming.workerId ? { workerId: incoming.workerId } : {}),
  };
  const kept = current.records.filter((record) => record.runId !== next.runId || record.workerId !== next.workerId);
  return { ok: true, records: [...kept, next] };
}

export function patternBPersistedIsolation(stored: unknown, runId: string): PatternBIsolationRecord | undefined {
  const current = readPatternBIsolationRecords(stored);
  if (!current.ok) return undefined;
  return current.records.find((record) => record.runId === runId);
}

export type PatternBFinish =
  | 'not_isolated'
  | 'continue'
  | 'needs_authorization'
  | 'authorized_finish'
  | 'cancel'
  | 'expired'
  | 'unreadable_records';

export function patternBInFlightDisposition(input: {
  readonly storedSwitch: unknown;
  readonly records: unknown;
  readonly runId: string;
  readonly now: string;
  readonly authorization?: { readonly runId: string; readonly explicit: true; readonly deadlineAt: string } | null;
}): PatternBFinish {
  const records = readPatternBIsolationRecords(input.records);
  if (!records.ok) return 'unreadable_records';
  const record = records.records.find((item) => item.runId === input.runId);
  if (!record) return 'not_isolated';
  const decision = readPatternBIsolationSwitch(input.storedSwitch);
  if (decision.enabled === true && decision.explicitOff !== true) return 'continue';
  if (patternBInFlightPolicy(input.storedSwitch) === 'cancel') return 'cancel';
  const authorization = input.authorization;
  if (!authorization || authorization.explicit !== true || authorization.runId !== input.runId) return 'needs_authorization';
  const deadline = Date.parse(authorization.deadlineAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(deadline) || Number.isNaN(now) || now > deadline) return 'expired';
  return 'authorized_finish';
}
