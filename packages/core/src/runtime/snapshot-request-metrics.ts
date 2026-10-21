/**
 * Per-prepare send metrics.
 *
 * `session.latestRequest` keeps only the newest send. Each prepared snapshot
 * turn keeps the estimate from the request that was actually sent for it.
 * Rows written before that send stay without these fields.
 */

import type { SessionMessage } from '../types.js';
import type { ContextSettingsStore } from '../session/history/window.js';
import { contextSnapshotRetentionLimit } from '../session/context-snapshot-store.js';

export interface SnapshotRequestMetric {
  requestId: string;
  sessionId: string;
  sentAt: string;
  estimatedTokens: number;
  windowTokens: number;
  actualInputTokens?: number;
}

export interface PrepareSlot {
  sessionId: string;
  snapshotId?: string;
  metric?: SnapshotRequestMetric;
}

interface StoredSnapshotRequest {
  requestId: string;
  estimatedTokens: number;
  windowTokens: number;
  sentAt: string;
  actualInputTokens?: number;
}

const slotsByMessages = new WeakMap<readonly SessionMessage[], PrepareSlot>();
const latestSlotByStore = new WeakMap<object, Map<string, PrepareSlot>>();

function storageKey(sessionId: string): string {
  return `session.snapshotRequests:${sessionId}`;
}

export function createPrepareSlot(sessionId: string): PrepareSlot {
  return { sessionId };
}

/** Bind this prepare to the messages that will actually be sent. */
export function linkPrepareSlot(
  store: object,
  sessionId: string,
  messages: readonly SessionMessage[],
  slot: PrepareSlot
): void {
  slotsByMessages.set(messages, slot);
  let bySession = latestSlotByStore.get(store);
  if (!bySession) {
    bySession = new Map();
    latestSlotByStore.set(store, bySession);
  }
  bySession.set(sessionId, slot);
}

/**
 * The slot queued for this send. A finished prepare (snapshot already stored
 * and already metered) is not reused for a later request that never linked.
 */
export function prepareSlotForRequest(
  store: object,
  sessionId: string,
  messages: readonly SessionMessage[] | undefined
): PrepareSlot | undefined {
  if (messages) {
    const linked = slotsByMessages.get(messages);
    if (linked?.sessionId === sessionId) return linked;
  }
  const latest = latestSlotByStore.get(store)?.get(sessionId);
  if (!latest || latest.sessionId !== sessionId) return undefined;
  if (latest.snapshotId && latest.metric) return undefined;
  if (messages) slotsByMessages.set(messages, latest);
  return latest;
}

function readMap(store: ContextSettingsStore, sessionId: string): Record<string, StoredSnapshotRequest> {
  const raw = store.getDaemonControl<Record<string, StoredSnapshotRequest>>(storageKey(sessionId));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function saveSnapshotRequest(
  store: ContextSettingsStore,
  sessionId: string,
  snapshotId: string,
  metric: SnapshotRequestMetric
): void {
  const map = readMap(store, sessionId);
  const prev = map[snapshotId];
  if (prev && prev.requestId !== metric.requestId && prev.sentAt > metric.sentAt) return;
  const next: StoredSnapshotRequest = {
    requestId: metric.requestId,
    estimatedTokens: metric.estimatedTokens,
    windowTokens: metric.windowTokens,
    sentAt: metric.sentAt
  };
  if (finite(metric.actualInputTokens)) next.actualInputTokens = metric.actualInputTokens;
  else if (prev && prev.requestId === metric.requestId && finite(prev.actualInputTokens)) {
    next.actualInputTokens = prev.actualInputTokens;
  }
  delete map[snapshotId];
  map[snapshotId] = next;
  const limit = contextSnapshotRetentionLimit();
  const ids = Object.keys(map);
  if (ids.length > limit) {
    for (const id of ids.slice(0, ids.length - limit)) delete map[id];
  }
  store.setDaemonControl?.(storageKey(sessionId), map);
}

function persistSlot(store: ContextSettingsStore, slot: PrepareSlot): void {
  if (!slot.snapshotId || !slot.metric) return;
  try {
    saveSnapshotRequest(store, slot.sessionId, slot.snapshotId, slot.metric);
  } catch {
    /* Observation must not block delivery or the snapshot write. */
  }
}

export function commitPrepareSnapshot(store: ContextSettingsStore, slot: PrepareSlot, snapshotId: string): void {
  slot.snapshotId = snapshotId;
  persistSlot(store, slot);
}

export function rememberPrepareMetric(
  store: ContextSettingsStore,
  slot: PrepareSlot,
  metric: SnapshotRequestMetric
): void {
  slot.metric = metric;
  persistSlot(store, slot);
}

export function rememberActualInput(
  store: ContextSettingsStore,
  slot: PrepareSlot,
  requestId: string,
  actualInputTokens: number
): void {
  if (!slot.metric || slot.metric.requestId !== requestId || !finite(actualInputTokens)) return;
  slot.metric = { ...slot.metric, actualInputTokens };
  persistSlot(store, slot);
}

export function attachSnapshotRequestMetrics<T extends { id: string }>(
  store: ContextSettingsStore,
  sessionId: string,
  snapshots: readonly T[]
): T[] {
  let map: Record<string, StoredSnapshotRequest>;
  try {
    map = readMap(store, sessionId);
  } catch {
    return [...snapshots];
  }
  if (Object.keys(map).length === 0) return [...snapshots];
  return snapshots.map((snap) => {
    const metric = map[snap.id];
    if (!metric || !finite(metric.estimatedTokens) || !finite(metric.windowTokens)) return snap;
    if (typeof metric.sentAt !== 'string' || !metric.sentAt) return snap;
    const attached: T & {
      estimatedTokens: number;
      windowTokens: number;
      sentAt: string;
      actualInputTokens?: number;
    } = {
      ...snap,
      estimatedTokens: metric.estimatedTokens,
      windowTokens: metric.windowTokens,
      sentAt: metric.sentAt
    };
    if (finite(metric.actualInputTokens)) attached.actualInputTokens = metric.actualInputTokens;
    return attached;
  });
}
