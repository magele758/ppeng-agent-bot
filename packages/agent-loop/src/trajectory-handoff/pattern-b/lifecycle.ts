/**
 * Host-controlled isolated-workspace lifecycle records.
 * Records do not decide trajectory handoff and do not grant budget.
 * They do not create directories and do not copy artifacts to a shared target.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalPath, pathContained } from './paths.js';
import type { LifecycleActor, WorkspaceLifecycleRecord } from './types.js';

export interface CreateWorkspaceInput {
  actor: LifecycleActor;
  runId: string;
  workerId: string;
  taskScope: string;
  planId?: string;
  planVersion?: string;
  writableRoot: string;
  now: string;
}

export type LifecycleFailureReason =
  | 'worker_denied'
  | 'invalid_root'
  | 'root_conflict'
  | 'not_found'
  | 'not_discardable';

export type LifecycleResult =
  | { ok: true; record: WorkspaceLifecycleRecord }
  | { ok: false; reason: LifecycleFailureReason };

export interface LifecycleStore {
  create(input: CreateWorkspaceInput): LifecycleResult;
  retain(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult;
  confirmDiscard(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult;
  cleanup(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult;
  get(lifecycleId: string): WorkspaceLifecycleRecord | undefined;
  list(): WorkspaceLifecycleRecord[];
}

interface PersistHook {
  load(): WorkspaceLifecycleRecord[];
  save(records: readonly WorkspaceLifecycleRecord[]): void;
}

const RECORD_KEY: Record<string, true> = {
  lifecycleId: true,
  runId: true,
  workerId: true,
  taskScope: true,
  planId: true,
  planVersion: true,
  writableRoot: true,
  phase: true,
  discardConfirmed: true,
  createdAt: true,
  updatedAt: true,
};


function copyRecord(record: WorkspaceLifecycleRecord): WorkspaceLifecycleRecord {
  const copy: WorkspaceLifecycleRecord = {
    lifecycleId: record.lifecycleId,
    runId: record.runId,
    workerId: record.workerId,
    taskScope: record.taskScope,
    writableRoot: record.writableRoot,
    phase: record.phase,
    discardConfirmed: record.discardConfirmed,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.planId !== undefined) copy.planId = record.planId;
  if (record.planVersion !== undefined) copy.planVersion = record.planVersion;
  return copy;
}


class LifecycleStoreImpl implements LifecycleStore {
  private records: WorkspaceLifecycleRecord[];

  constructor(private readonly persist: PersistHook) {
    this.records = persist.load().map(copyRecord);
  }

  create(input: CreateWorkspaceInput): LifecycleResult {
    if (input.actor.kind === 'worker') return { ok: false, reason: 'worker_denied' };
    const root = canonicalPath(input.writableRoot);
    if (!root) return { ok: false, reason: 'invalid_root' };
    const existing = this.records.find((record) => record.runId === input.runId && record.workerId === input.workerId);
    if (existing) {
      if (existing.writableRoot !== root) return { ok: false, reason: 'root_conflict' };
      return { ok: true, record: copyRecord(existing) };
    }
    if (this.records.some((record) => record.writableRoot === root || pathContained(record.writableRoot, root) || pathContained(root, record.writableRoot))) {
      return { ok: false, reason: 'root_conflict' };
    }
    const record: WorkspaceLifecycleRecord = {
      lifecycleId: `lc:${input.runId}:${input.workerId}`,
      runId: input.runId,
      workerId: input.workerId,
      taskScope: input.taskScope,
      writableRoot: root,
      phase: 'created',
      discardConfirmed: false,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (input.planId !== undefined) record.planId = input.planId;
    if (input.planVersion !== undefined) record.planVersion = input.planVersion;
    this.records.push(record);
    this.persist.save(this.records);
    return { ok: true, record: copyRecord(record) };
  }

  retain(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult {
    if (input.actor.kind === 'worker') return { ok: false, reason: 'worker_denied' };
    const record = this.records.find((item) => item.lifecycleId === input.lifecycleId);
    if (!record) return { ok: false, reason: 'not_found' };
    record.phase = 'retained';
    record.updatedAt = input.now;
    this.persist.save(this.records);
    return { ok: true, record: copyRecord(record) };
  }

  confirmDiscard(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult {
    if (input.actor.kind === 'worker') return { ok: false, reason: 'worker_denied' };
    const record = this.records.find((item) => item.lifecycleId === input.lifecycleId);
    if (!record) return { ok: false, reason: 'not_found' };
    record.discardConfirmed = true;
    record.updatedAt = input.now;
    this.persist.save(this.records);
    return { ok: true, record: copyRecord(record) };
  }

  cleanup(input: { actor: LifecycleActor; lifecycleId: string; now: string }): LifecycleResult {
    if (input.actor.kind === 'worker') return { ok: false, reason: 'worker_denied' };
    const record = this.records.find((item) => item.lifecycleId === input.lifecycleId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (!record.discardConfirmed) return { ok: false, reason: 'not_discardable' };
    record.phase = 'cleaned';
    record.updatedAt = input.now;
    this.persist.save(this.records);
    return { ok: true, record: copyRecord(record) };
  }

  get(lifecycleId: string): WorkspaceLifecycleRecord | undefined {
    const record = this.records.find((item) => item.lifecycleId === lifecycleId);
    return record ? copyRecord(record) : undefined;
  }

  list(): WorkspaceLifecycleRecord[] {
    return this.records.map(copyRecord);
  }
}

function isLifecyclePhase(value: unknown): value is WorkspaceLifecycleRecord['phase'] {
  return value === 'created'
    || value === 'retained'
    || value === 'cleanup_pending'
    || value === 'cleaned';
}

function parseRequiredRecord(value: object): WorkspaceLifecycleRecord | undefined {
  if (!('lifecycleId' in value) || typeof value.lifecycleId !== 'string') return undefined;
  if (!('runId' in value) || typeof value.runId !== 'string') return undefined;
  if (!('workerId' in value) || typeof value.workerId !== 'string') return undefined;
  if (!('taskScope' in value) || typeof value.taskScope !== 'string') return undefined;
  if (!('writableRoot' in value) || typeof value.writableRoot !== 'string') return undefined;
  if (!('phase' in value) || !isLifecyclePhase(value.phase)) return undefined;
  if (!('discardConfirmed' in value) || typeof value.discardConfirmed !== 'boolean') return undefined;
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return undefined;
  if (!('updatedAt' in value) || typeof value.updatedAt !== 'string') return undefined;
  return {
    lifecycleId: value.lifecycleId,
    runId: value.runId,
    workerId: value.workerId,
    taskScope: value.taskScope,
    writableRoot: value.writableRoot,
    phase: value.phase,
    discardConfirmed: value.discardConfirmed,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function withOptionalPlanFields(
  record: WorkspaceLifecycleRecord,
  value: object,
): WorkspaceLifecycleRecord | undefined {
  if ('planId' in value) {
    if (typeof value.planId !== 'string') return undefined;
    record.planId = value.planId;
  }
  if ('planVersion' in value) {
    if (typeof value.planVersion !== 'string') return undefined;
    record.planVersion = value.planVersion;
  }
  return record;
}

function parseStoredRecord(value: unknown): WorkspaceLifecycleRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (RECORD_KEY[key] !== true) return undefined;
  }
  const record = parseRequiredRecord(value);
  if (!record) return undefined;
  return withOptionalPlanFields(record, value);
}

function memoryHook(initial: WorkspaceLifecycleRecord[] = []): PersistHook {
  let snapshot = initial.map(copyRecord);
  return {
    load: () => snapshot.map(copyRecord),
    save: (records) => {
      snapshot = records.map(copyRecord);
    },
  };
}

function fileHook(filePath: string): PersistHook {
  return {
    load: () => readLifecycleFile(filePath),
    save: (records) => {
      const body = JSON.stringify({ records: records.map(copyRecord) });
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, filePath);
    },
  };
}

function readLifecycleFile(filePath: string): WorkspaceLifecycleRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error('lifecycle store unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('lifecycle store unreadable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('records' in parsed) || !Array.isArray(parsed.records)) {
    throw new Error('lifecycle store unreadable');
  }
  const records: WorkspaceLifecycleRecord[] = [];
  for (const item of parsed.records) {
    const record = parseStoredRecord(item);
    if (!record) throw new Error('lifecycle store unreadable');
    records.push(record);
  }
  return records;
}

export function createMemoryLifecycleStore(): LifecycleStore {
  return new LifecycleStoreImpl(memoryHook());
}

export function createFileLifecycleStore(filePath: string): LifecycleStore {
  return new LifecycleStoreImpl(fileHook(filePath));
}
