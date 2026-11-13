import { factFingerprint } from '../cron/notification-decision.js';
import type { SqliteStateStore } from '../storage.js';

interface WireShape { header: string; items: string[] }
interface WireRecord extends WireShape { firstDifference: string; at: string }

/** Fingerprint the actual outgoing model input; never retain request content or media. */
export function recordWireShape(store: SqliteStateStore, sid: string, body: Readonly<Record<string, unknown>>): string | undefined {
  const { input, messages, stream: _stream, stream_options: _options, ...header } = body;
  const items = input ?? messages;
  if (!Array.isArray(items)) return;
  const key = 'request-wire:v1:' + sid;
  const old = store.getDaemonControl<WireShape>(key);
  const next = { header: factFingerprint(header), items: items.map(factFingerprint) };
  const record: WireRecord = { ...next, at: new Date().toISOString(), firstDifference: difference(old, next) };
  store.setDaemonControl(key, record);
  return record.firstDifference;
}

function difference(old: WireShape | undefined, next: WireShape): string {
  if (!old) return 'first-request';
  if (old.header !== next.header) return 'request-settings';
  const length = Math.min(old.items.length, next.items.length);
  for (let i = 0; i < length; i++) {
    if (old.items[i] !== next.items[i]) return 'input[' + i + ']';
  }
  if (old.items.length === next.items.length) return 'unchanged';
  return old.items.length < next.items.length ? 'append-only' : 'shortened';
}
