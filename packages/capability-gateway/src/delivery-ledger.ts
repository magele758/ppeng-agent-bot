/**
 * At-least-once ledger for outbound IM text.
 * A row is persisted as `attempting` before the send, so a crash mid-send
 * is redelivered with a visible recovered-reply prefix. Confirmed deliveries
 * are not sent again. This is not exactly-once.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECOVERED_REPLY_PREFIX =
  '♻️ Recovered reply — the gateway restarted during delivery, so this may be a duplicate:\n\n';

const MAX_ATTEMPTS = 8;

export type DeliveryTarget =
  | { type: 'channel'; channelId: string }
  | {
      type: 'feishu';
      receiveId: string;
      receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'chat_id';
    };

type DeliveryState = 'pending' | 'attempting' | 'delivered' | 'failed' | 'abandoned';

export interface DeliveryRow {
  id: string;
  target: DeliveryTarget;
  content: string;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** Set when the row belongs to an outbound draft, so reject/reapprove can cancel it. */
  draftId?: string;
}

interface LedgerFile {
  version: 1;
  items: DeliveryRow[];
}

const tails = new Map<string, Promise<void>>();

function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(dir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    dir,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function ledgerPath(dir: string): string {
  return join(dir, 'delivery-ledger.json');
}

function readLedger(dir: string): LedgerFile {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) as LedgerFile;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items)) return { version: 1, items: [] };
    return { version: 1, items: raw.items };
  } catch {
    return { version: 1, items: [] };
  }
}

function writeLedger(dir: string, file: LedgerFile): void {
  mkdirSync(dir, { recursive: true });
  const path = ledgerPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function nowIso(): string {
  return new Date().toISOString();
}

function withRecoveredPrefix(content: string): string {
  return content.startsWith(RECOVERED_REPLY_PREFIX) ? content : `${RECOVERED_REPLY_PREFIX}${content}`;
}

function comparableDeliveryText(content: string): string {
  return content.startsWith(RECOVERED_REPLY_PREFIX) ? content.slice(RECOVERED_REPLY_PREFIX.length) : content;
}

function abandonOpenDraftRows(dir: string, draftId: string): number {
  const file = readLedger(dir);
  let changed = 0;
  for (const row of file.items) {
    if (row.draftId !== draftId) continue;
    if (row.state === 'delivered' || row.state === 'abandoned') continue;
    row.state = 'abandoned';
    row.updatedAt = nowIso();
    changed += 1;
  }
  if (changed > 0) writeLedger(dir, file);
  return changed;
}

/** True when a draft's ledger row was confirmed delivered. */
export function draftWasDelivered(dir: string, draftId: string): boolean {
  return readLedger(dir).items.some((row) => row.draftId === draftId && row.state === 'delivered');
}

/** Drop retryable rows for a draft. Delivered rows stay so they are not sent again. */
export async function abandonDraftDeliveries(dir: string, draftId: string): Promise<number> {
  return withLock(dir, async () => abandonOpenDraftRows(dir, draftId));
}

/**
 * Decide a crash reconcile under the ledger lock.
 * An in-flight `sendLedgered` holds the same lock, so this sees the row only
 * after that send has finished. Returns whether delivery was confirmed.
 */
export async function closeUnconfirmedDraft(dir: string, draftId: string): Promise<boolean> {
  return withLock(dir, async () => {
    const delivered = draftWasDelivered(dir, draftId);
    if (!delivered) abandonOpenDraftRows(dir, draftId);
    return delivered;
  });
}

/** Persist an in-flight send. A crash after this returns is a duplicate-risk redelivery. */
export function beginOutboundAttempt(dir: string, target: DeliveryTarget, text: string, draftId?: string): string {
  const file = readLedger(dir);
  const ts = nowIso();
  const row: DeliveryRow = {
    id: `dlv_${randomUUID()}`,
    target,
    content: text,
    state: 'attempting',
    attempts: 1,
    createdAt: ts,
    updatedAt: ts,
    ...(draftId ? { draftId } : {})
  };
  file.items.push(row);
  writeLedger(dir, file);
  return row.id;
}

export function finishOutbound(dir: string, id: string, state: 'delivered' | 'failed'): void {
  const file = readLedger(dir);
  const row = file.items.find((item) => item.id === id);
  if (!row) return;
  row.state = state;
  row.updatedAt = nowIso();
  writeLedger(dir, file);
}

/**
 * Drop unfinished rows that predate draftId. They match a draft's text, so
 * reject/reapprove must not replay them. Delivered rows and unrelated IM stay.
 * This does not send.
 */
export async function quarantineUnlinkedDraftRows(dir: string, draftTexts: readonly string[]): Promise<number> {
  const keys = new Set(draftTexts.map(comparableDeliveryText));
  if (keys.size === 0) return 0;
  return withLock(dir, async () => {
    const file = readLedger(dir);
    let changed = 0;
    for (const row of file.items) {
      if (row.draftId) continue;
      if (row.state === 'delivered' || row.state === 'abandoned') continue;
      if (!keys.has(comparableDeliveryText(row.content))) continue;
      row.state = 'abandoned';
      row.updatedAt = nowIso();
      changed += 1;
    }
    if (changed > 0) writeLedger(dir, file);
    return changed;
  });
}

export async function sendLedgered(opts: {
  gatewayDir: string;
  target: DeliveryTarget;
  text: string;
  draftId?: string;
  send: (text: string) => Promise<void>;
}): Promise<void> {
  await withLock(opts.gatewayDir, async () => {
    if (opts.draftId && draftWasDelivered(opts.gatewayDir, opts.draftId)) {
      abandonOpenDraftRows(opts.gatewayDir, opts.draftId);
      return;
    }
    if (opts.draftId) abandonOpenDraftRows(opts.gatewayDir, opts.draftId);
    const id = beginOutboundAttempt(opts.gatewayDir, opts.target, opts.text, opts.draftId);
    try {
      await opts.send(opts.text);
      finishOutbound(opts.gatewayDir, id, 'delivered');
    } catch (err) {
      finishOutbound(opts.gatewayDir, id, 'failed');
      throw err;
    }
  });
}

/**
 * Redeliver rows that were not confirmed. `attempting` / `failed` may already
 * have reached the platform, so the text is prefixed. `pending` (send never
 * started) is resent as-is. `delivered` is left alone.
 */
export async function recoverOutboundLedger(
  dir: string,
  send: (row: DeliveryRow, text: string) => Promise<void>
): Promise<number> {
  return withLock(dir, async () => {
    const file = readLedger(dir);
    let sent = 0;
    for (const row of file.items) {
      if (row.state === 'delivered' || row.state === 'abandoned') continue;
      if (row.attempts >= MAX_ATTEMPTS) {
        row.state = 'abandoned';
        row.updatedAt = nowIso();
        writeLedger(dir, file);
        continue;
      }
      const needsMarker = row.state !== 'pending';
      row.attempts += 1;
      row.state = 'attempting';
      row.updatedAt = nowIso();
      writeLedger(dir, file);
      const text = needsMarker ? withRecoveredPrefix(row.content) : row.content;
      try {
        await send(row, text);
        row.state = 'delivered';
        sent += 1;
      } catch {
        row.state = 'failed';
      }
      row.updatedAt = nowIso();
      writeLedger(dir, file);
    }
    return sent;
  });
}
