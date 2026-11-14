/**
 * Host-authorized integration records.
 * Same integrationId is idempotent. Unknown results are not auto-replayed.
 * This is not an agent loop and does not grant budget.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  IntegrationRecord,
  IntegrationStatus,
  LifecycleActor,
  ReconcileEvidence,
} from './types.js';

export interface IntegrationEffects {
  apply(record: IntegrationRecord): void;
}

export interface AuthorizeInput {
  actor: LifecycleActor;
  integrationId: string;
  runId: string;
  workerId: string;
  planVersion: string;
  taskScope: string;
  artifactVersion: string;
  targetId: string;
  expectedTargetVersion: string;
  resultTargetVersion: string;
  deadlineAt: string;
  now: string;
}

export interface BindingProof {
  runId: string;
  workerId: string;
  planVersion: string;
  taskScope: string;
  artifactVersion: string;
  expectedTargetVersion: string;
}

export interface InvalidateFilter {
  runId?: string;
  workerId?: string;
  targetId?: string;
  planVersion?: string;
  taskScope?: string;
}

export type StoreFailureReason =
  | 'worker_denied'
  | 'invalid'
  | 'in_flight'
  | 'already_accepted'
  | 'not_found'
  | 'binding_mismatch'
  | 'target_moved'
  | 'target_held'
  | 'expired'
  | 'fail_closed'
  | 'not_applying';

export type StoreResult =
  | { ok: true; record: IntegrationRecord }
  | { ok: false; reason: StoreFailureReason; record?: IntegrationRecord };

export interface IntegrationStore {
  authorize(input: AuthorizeInput): StoreResult;
  begin(integrationId: string, proof: BindingProof, now: string): StoreResult;
  commit(integrationId: string, now: string): StoreResult;
  crashUncommitted(integrationId: string): IntegrationRecord | undefined;
  reconcile(integrationId: string, evidence: ReconcileEvidence, now: string): StoreResult;
  invalidate(filter: InvalidateFilter, now: string): IntegrationRecord[];
  noteTargetVersion(targetId: string, version: string, now: string): void;
  get(integrationId: string): IntegrationRecord | undefined;
  targetVersion(targetId: string): string | undefined;
}

interface TargetSlot {
  version: string;
  holder?: string;
}

interface Snapshot {
  records: IntegrationRecord[];
  targets: Record<string, TargetSlot>;
}

interface PersistHook {
  load(): Snapshot;
  save(snapshot: Snapshot): void;
}

const STATUSES: Record<IntegrationStatus, true> = {
  authorized: true,
  applying: true,
  unknown: true,
  accepted: true,
  rejected: true,
  expired: true,
};

const OPEN_STATUSES: Record<string, true> = {
  authorized: true,
  applying: true,
  unknown: true,
};

export function logicalIntegrationKey(parts: {
  runId: string;
  workerId: string;
  planVersion: string;
  taskScope: string;
  artifactVersion: string;
  targetId: string;
}): string {
  return [
    parts.runId,
    parts.workerId,
    parts.planVersion,
    parts.taskScope,
    parts.artifactVersion,
    parts.targetId,
  ].join('\0');
}

function copyRecord(record: IntegrationRecord): IntegrationRecord {
  const copy: IntegrationRecord = {
    integrationId: record.integrationId,
    runId: record.runId,
    workerId: record.workerId,
    planVersion: record.planVersion,
    taskScope: record.taskScope,
    artifactVersion: record.artifactVersion,
    targetId: record.targetId,
    expectedTargetVersion: record.expectedTargetVersion,
    resultTargetVersion: record.resultTargetVersion,
    deadlineAt: record.deadlineAt,
    authorizedAt: record.authorizedAt,
    status: record.status,
    sideEffectCount: record.sideEffectCount,
    logicalKey: record.logicalKey,
  };
  if (record.observedTargetVersion !== undefined) copy.observedTargetVersion = record.observedTargetVersion;
  if (record.reason !== undefined) copy.reason = record.reason;
  return copy;
}

function copySlot(slot: TargetSlot): TargetSlot {
  return slot.holder === undefined ? { version: slot.version } : { version: slot.version, holder: slot.holder };
}

function clock(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function authorizeInputValid(input: AuthorizeInput): boolean {
  const fields = [
    input.integrationId,
    input.runId,
    input.workerId,
    input.planVersion,
    input.taskScope,
    input.artifactVersion,
    input.targetId,
    input.expectedTargetVersion,
    input.resultTargetVersion,
    input.deadlineAt,
    input.now,
  ];
  return fields.every((field) => field.length > 0) && !Number.isNaN(clock(input.deadlineAt)) && !Number.isNaN(clock(input.now));
}

function proofMatches(record: IntegrationRecord, proof: BindingProof): boolean {
  return record.runId === proof.runId
    && record.workerId === proof.workerId
    && record.planVersion === proof.planVersion
    && record.taskScope === proof.taskScope
    && record.artifactVersion === proof.artifactVersion
    && record.expectedTargetVersion === proof.expectedTargetVersion;
}

function clearHolder(targets: Record<string, TargetSlot>, targetId: string, integrationId: string): void {
  const slot = targets[targetId];
  if (!slot || slot.holder !== integrationId) return;
  targets[targetId] = { version: slot.version };
}

function sameAuthorization(record: IntegrationRecord, input: AuthorizeInput): boolean {
  return record.runId === input.runId
    && record.workerId === input.workerId
    && record.planVersion === input.planVersion
    && record.taskScope === input.taskScope
    && record.artifactVersion === input.artifactVersion
    && record.targetId === input.targetId
    && record.expectedTargetVersion === input.expectedTargetVersion
    && record.resultTargetVersion === input.resultTargetVersion
    && record.deadlineAt === input.deadlineAt;
}

function terminalReason(record: IntegrationRecord): StoreFailureReason {
  if (
    record.reason === 'binding_mismatch'
    || record.reason === 'target_moved'
    || record.reason === 'target_held'
    || record.reason === 'expired'
  ) {
    return record.reason;
  }
  return 'fail_closed';
}

class IntegrationStoreImpl implements IntegrationStore {
  private records: IntegrationRecord[];
  private targets: Record<string, TargetSlot>;

  constructor(
    private readonly effects: IntegrationEffects,
    private readonly persist: PersistHook,
  ) {
    const loaded = persist.load();
    this.records = loaded.records.map(copyRecord);
    this.targets = {};
    for (const [id, slot] of Object.entries(loaded.targets)) this.targets[id] = copySlot(slot);
  }

  private save(): void {
    const targets: Record<string, TargetSlot> = {};
    for (const [id, slot] of Object.entries(this.targets)) targets[id] = copySlot(slot);
    this.persist.save({ records: this.records.map(copyRecord), targets });
  }

  private find(integrationId: string): IntegrationRecord | undefined {
    return this.records.find((record) => record.integrationId === integrationId);
  }

  authorize(input: AuthorizeInput): StoreResult {
    if (input.actor.kind === 'worker') return { ok: false, reason: 'worker_denied' };
    if (!authorizeInputValid(input)) return { ok: false, reason: 'invalid' };
    const existing = this.find(input.integrationId);
    if (existing) {
      if (!sameAuthorization(existing, input)) {
        return { ok: false, reason: 'binding_mismatch', record: copyRecord(existing) };
      }
      return { ok: true, record: copyRecord(existing) };
    }
    const logicalKey = logicalIntegrationKey(input);
    const siblings = this.records.filter((record) => record.logicalKey === logicalKey);
    const blocking = siblings.find((record) => OPEN_STATUSES[record.status] === true);
    if (blocking) return { ok: false, reason: 'in_flight', record: copyRecord(blocking) };
    const accepted = siblings.find((record) => record.status === 'accepted');
    if (accepted) return { ok: false, reason: 'already_accepted', record: copyRecord(accepted) };
    const expired = clock(input.deadlineAt) <= clock(input.now);
    const record: IntegrationRecord = {
      integrationId: input.integrationId,
      runId: input.runId,
      workerId: input.workerId,
      planVersion: input.planVersion,
      taskScope: input.taskScope,
      artifactVersion: input.artifactVersion,
      targetId: input.targetId,
      expectedTargetVersion: input.expectedTargetVersion,
      resultTargetVersion: input.resultTargetVersion,
      deadlineAt: input.deadlineAt,
      authorizedAt: input.now,
      status: expired ? 'expired' : 'authorized',
      sideEffectCount: 0,
      logicalKey,
    };
    if (expired) record.reason = 'expired';
    this.records.push(record);
    this.save();
    return { ok: true, record: copyRecord(record) };
  }

  begin(integrationId: string, proof: BindingProof, now: string): StoreResult {
    const record = this.find(integrationId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (!proofMatches(record, proof)) {
      if (record.status === 'authorized') {
        record.status = 'rejected';
        record.reason = 'binding_mismatch';
        this.save();
      }
      return { ok: false, reason: 'binding_mismatch', record: copyRecord(record) };
    }
    if (record.status === 'accepted') return { ok: true, record: copyRecord(record) };
    if (record.status === 'unknown') return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    if (record.status === 'expired') return { ok: false, reason: 'expired', record: copyRecord(record) };
    if (record.status === 'rejected') {
      return { ok: false, reason: terminalReason(record), record: copyRecord(record) };
    }
    if (Number.isNaN(clock(now))) return { ok: false, reason: 'invalid', record: copyRecord(record) };
    if (clock(now) >= clock(record.deadlineAt)) {
      if (record.status === 'applying') {
        record.status = 'unknown';
        record.reason = 'expired';
        this.save();
        return { ok: false, reason: 'expired', record: copyRecord(record) };
      }
      record.status = 'expired';
      record.reason = 'expired';
      this.save();
      return { ok: false, reason: 'expired', record: copyRecord(record) };
    }
    if (record.status === 'applying') return { ok: true, record: copyRecord(record) };
    const target = this.targets[record.targetId];
    if (!target || target.version !== record.expectedTargetVersion) {
      record.status = 'rejected';
      record.reason = 'target_moved';
      this.save();
      return { ok: false, reason: 'target_moved', record: copyRecord(record) };
    }
    if (target.holder !== undefined && target.holder !== integrationId) {
      record.status = 'rejected';
      record.reason = 'target_held';
      this.save();
      return { ok: false, reason: 'target_held', record: copyRecord(record) };
    }
    target.holder = integrationId;
    record.status = 'applying';
    record.sideEffectCount = 1;
    this.save();
    try {
      this.effects.apply(copyRecord(record));
    } catch {
      record.status = 'unknown';
      record.reason = 'apply_failed';
      this.save();
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    return { ok: true, record: copyRecord(record) };
  }

  commit(integrationId: string, now: string): StoreResult {
    const record = this.find(integrationId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'accepted') return { ok: true, record: copyRecord(record) };
    if (record.status === 'unknown') return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    if (record.status !== 'applying') return { ok: false, reason: 'not_applying', record: copyRecord(record) };
    if (Number.isNaN(clock(now))) return { ok: false, reason: 'invalid', record: copyRecord(record) };
    if (clock(now) >= clock(record.deadlineAt)) {
      record.status = 'unknown';
      record.reason = 'expired';
      this.save();
      return { ok: false, reason: 'expired', record: copyRecord(record) };
    }
    const target = this.targets[record.targetId];
    if (!target || target.holder !== integrationId || target.version !== record.expectedTargetVersion) {
      record.status = 'unknown';
      record.reason = 'target_moved';
      this.save();
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    this.targets[record.targetId] = { version: record.resultTargetVersion };
    record.status = 'accepted';
    record.observedTargetVersion = record.resultTargetVersion;
    this.save();
    return { ok: true, record: copyRecord(record) };
  }

  crashUncommitted(integrationId: string): IntegrationRecord | undefined {
    const record = this.find(integrationId);
    if (!record) return undefined;
    if (record.status !== 'applying') return copyRecord(record);
    record.status = 'unknown';
    record.reason = 'crashed';
    this.save();
    return copyRecord(record);
  }

  reconcile(integrationId: string, evidence: ReconcileEvidence, now: string): StoreResult {
    void now;
    const record = this.find(integrationId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'accepted') return { ok: true, record: copyRecord(record) };
    if (record.status !== 'unknown' && record.status !== 'applying') {
      if (record.status === 'expired') return { ok: false, reason: 'expired', record: copyRecord(record) };
      if (record.status === 'rejected') return { ok: false, reason: terminalReason(record), record: copyRecord(record) };
      return { ok: false, reason: 'not_applying', record: copyRecord(record) };
    }
    if (record.status === 'applying') {
      record.status = 'unknown';
      record.reason = 'crashed';
      this.save();
    }
    if (evidence.observed !== 'applied' && evidence.observed !== 'not_applied') {
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    if (evidence.observed === 'not_applied') {
      clearHolder(this.targets, record.targetId, integrationId);
      record.status = 'rejected';
      record.reason = 'not_applied';
      this.save();
      return { ok: true, record: copyRecord(record) };
    }
    if (evidence.observedTargetVersion !== record.resultTargetVersion) {
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    const slot = this.targets[record.targetId];
    if (!slot || (slot.holder !== undefined && slot.holder !== integrationId)) {
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    if (slot.version !== record.expectedTargetVersion && slot.version !== record.resultTargetVersion) {
      return { ok: false, reason: 'fail_closed', record: copyRecord(record) };
    }
    this.targets[record.targetId] = { version: record.resultTargetVersion };
    record.status = 'accepted';
    record.observedTargetVersion = record.resultTargetVersion;
    this.save();
    return { ok: true, record: copyRecord(record) };
  }

  invalidate(filter: InvalidateFilter, now: string): IntegrationRecord[] {
    void now;
    const fields = [filter.runId, filter.workerId, filter.targetId, filter.planVersion, filter.taskScope];
    if (fields.every((field) => field === undefined)) return [];
    const changed: IntegrationRecord[] = [];
    for (const record of this.records) {
      if (record.status !== 'authorized' || record.sideEffectCount !== 0) continue;
      if (filter.runId !== undefined && filter.runId !== record.runId) continue;
      if (filter.workerId !== undefined && filter.workerId !== record.workerId) continue;
      if (filter.targetId !== undefined && filter.targetId !== record.targetId) continue;
      if (filter.planVersion !== undefined && filter.planVersion !== record.planVersion) continue;
      if (filter.taskScope !== undefined && filter.taskScope !== record.taskScope) continue;
      record.status = 'rejected';
      record.reason = 'invalidated';
      changed.push(copyRecord(record));
    }
    if (changed.length > 0) this.save();
    return changed;
  }

  noteTargetVersion(targetId: string, version: string, now: string): void {
    void now;
    const current = this.targets[targetId];
    this.targets[targetId] = current?.holder === undefined
      ? { version }
      : { version, holder: current.holder };
    for (const record of this.records) {
      if (record.status !== 'authorized' || record.targetId !== targetId) continue;
      if (record.expectedTargetVersion === version) continue;
      record.status = 'rejected';
      record.reason = 'target_moved';
    }
    this.save();
  }

  get(integrationId: string): IntegrationRecord | undefined {
    const record = this.find(integrationId);
    return record ? copyRecord(record) : undefined;
  }

  targetVersion(targetId: string): string | undefined {
    return this.targets[targetId]?.version;
  }
}

function seedTargets(seed: Record<string, string> | undefined): Record<string, TargetSlot> {
  const targets: Record<string, TargetSlot> = {};
  if (!seed) return targets;
  for (const [id, version] of Object.entries(seed)) targets[id] = { version };
  return targets;
}

const RECORD_KEY: Record<string, true> = {
  integrationId: true,
  runId: true,
  workerId: true,
  planVersion: true,
  taskScope: true,
  artifactVersion: true,
  targetId: true,
  expectedTargetVersion: true,
  resultTargetVersion: true,
  deadlineAt: true,
  authorizedAt: true,
  status: true,
  sideEffectCount: true,
  logicalKey: true,
  observedTargetVersion: true,
  reason: true,
};

function stringField(value: object, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const field: unknown = value[key as keyof typeof value];
  return typeof field === 'string' ? field : undefined;
}

function parseStoredRecord(value: unknown): IntegrationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (RECORD_KEY[key] !== true) return undefined;
  }
  const integrationId = stringField(value, 'integrationId');
  const runId = stringField(value, 'runId');
  const workerId = stringField(value, 'workerId');
  const planVersion = stringField(value, 'planVersion');
  const taskScope = stringField(value, 'taskScope');
  const artifactVersion = stringField(value, 'artifactVersion');
  const targetId = stringField(value, 'targetId');
  const expectedTargetVersion = stringField(value, 'expectedTargetVersion');
  const resultTargetVersion = stringField(value, 'resultTargetVersion');
  const deadlineAt = stringField(value, 'deadlineAt');
  const authorizedAt = stringField(value, 'authorizedAt');
  const logicalKey = stringField(value, 'logicalKey');
  const status = stringField(value, 'status');
  if (!integrationId || !runId || !workerId || !planVersion || !taskScope || !artifactVersion || !targetId) return undefined;
  if (!expectedTargetVersion || !resultTargetVersion || !deadlineAt || !authorizedAt || !logicalKey || !status) return undefined;
  if (STATUSES[status as IntegrationStatus] !== true) return undefined;
  if (!('sideEffectCount' in value) || typeof value.sideEffectCount !== 'number') return undefined;
  const record: IntegrationRecord = {
    integrationId,
    runId,
    workerId,
    planVersion,
    taskScope,
    artifactVersion,
    targetId,
    expectedTargetVersion,
    resultTargetVersion,
    deadlineAt,
    authorizedAt,
    status: status as IntegrationStatus,
    sideEffectCount: value.sideEffectCount,
    logicalKey,
  };
  if ('observedTargetVersion' in value) {
    if (typeof value.observedTargetVersion !== 'string') return undefined;
    record.observedTargetVersion = value.observedTargetVersion;
  }
  if ('reason' in value) {
    if (typeof value.reason !== 'string') return undefined;
    record.reason = value.reason;
  }
  return record;
}

function parseTargets(value: unknown): Record<string, TargetSlot> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const targets: Record<string, TargetSlot> = {};
  for (const [id, slot] of Object.entries(value)) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return undefined;
    for (const key of Object.keys(slot)) {
      if (key !== 'version' && key !== 'holder') return undefined;
    }
    if (!('version' in slot) || typeof slot.version !== 'string') return undefined;
    const target: TargetSlot = { version: slot.version };
    if ('holder' in slot) {
      if (typeof slot.holder !== 'string') return undefined;
      target.holder = slot.holder;
    }
    targets[id] = target;
  }
  return targets;
}

function readIntegrationFile(filePath: string, seed: Record<string, string> | undefined): Snapshot {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { records: [], targets: seedTargets(seed) };
    }
    throw new Error('integration store unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('integration store unreadable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('records' in parsed) || !('targets' in parsed)) {
    throw new Error('integration store unreadable');
  }
  if (!Array.isArray(parsed.records)) throw new Error('integration store unreadable');
  const targets = parseTargets(parsed.targets);
  if (!targets) throw new Error('integration store unreadable');
  const records: IntegrationRecord[] = [];
  for (const item of parsed.records) {
    const record = parseStoredRecord(item);
    if (!record) throw new Error('integration store unreadable');
    if (record.status === 'applying') {
      record.status = 'unknown';
      record.reason = 'crashed';
    }
    records.push(record);
  }
  return { records, targets };
}

function memoryHook(seed: Record<string, string> | undefined): PersistHook {
  let snapshot: Snapshot = { records: [], targets: seedTargets(seed) };
  return {
    load: () => ({
      records: snapshot.records.map(copyRecord),
      targets: Object.fromEntries(Object.entries(snapshot.targets).map(([id, slot]) => [id, copySlot(slot)])),
    }),
    save: (next) => {
      snapshot = {
        records: next.records.map(copyRecord),
        targets: Object.fromEntries(Object.entries(next.targets).map(([id, slot]) => [id, copySlot(slot)])),
      };
    },
  };
}

function fileHook(filePath: string, seed: Record<string, string> | undefined): PersistHook {
  return {
    load: () => readIntegrationFile(filePath, seed),
    save: (snapshot) => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        records: snapshot.records.map(copyRecord),
        targets: snapshot.targets,
      }));
      renameSync(tmp, filePath);
    },
  };
}

export function createMemoryIntegrationStore(
  effects: IntegrationEffects,
  options?: { targets?: Record<string, string> },
): IntegrationStore {
  return new IntegrationStoreImpl(effects, memoryHook(options?.targets));
}

export function createFileIntegrationStore(
  filePath: string,
  effects: IntegrationEffects,
  options?: { targets?: Record<string, string> },
): IntegrationStore {
  return new IntegrationStoreImpl(effects, fileHook(filePath, options?.targets));
}
