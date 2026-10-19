/**
 * Inbox overflow `drop=summarize` (Phase 3 / OpenClaw queue cap).
 *
 * Lab default: off / ∞. Operator sets inboxOverflowCap (suggested 20) to fold
 * oldest unclaimed items into one system summary. Same stable key overwrites
 * earlier summaries at claim. No RAW_AGENT_* env vars — policy lives on
 * loop_settings KV (daemon control). Phase 4 will add per-session opt-in.
 *
 * When enqueue pushes unclaimed over the cap, oldest items are claimed (dropped)
 * and one summary takes their place — net reduction to cap-1 unclaimed.
 */

import type { EnqueueSteerOptions, InboxItem } from './step-inbox.js';

/** Must match `AGENT_LOOP_SETTINGS_KEY` in steer-drain.ts (avoid import cycle). */
const LOOP_SETTINGS_KV_KEY = 'loop_settings';

/** Stable key so later overflow summaries overlay earlier ones at claim. */
export const INBOX_OVERFLOW_KEY = 'inbox-overflow';
export const INBOX_OVERFLOW_PREFIX = '[inbox overflow]';
/** Suggested Lab value when the operator turns the feature on. */
export const SUGGESTED_INBOX_OVERFLOW_CAP = 20;
/** Default: off / ∞ — never drop. */
export const DEFAULT_INBOX_OVERFLOW_CAP: number | null = null;

const ITEM_TEXT_MAX = 240;
const SUMMARY_MAX = 2400;

export interface InboxOverflowHost {
  listUnclaimed(sessionId: string): InboxItem[];
  markClaimed(ids: string[]): void;
  enqueueSummary(sessionId: string, text: string, opts: EnqueueSteerOptions): InboxItem;
}

export interface InboxOverflowSettingsStore {
  getDaemonControl?(key: string): unknown;
}

/**
 * Valid cap: positive integer.
 * Explicit off: null (also 0 / false / 'off' / 'unlimited' / Infinity).
 * Omitted or invalid: undefined.
 */
export function parseInboxOverflowCap(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === false) return null;
  if (raw === true) return SUGGESTED_INBOX_OVERFLOW_CAP;
  if (typeof raw === 'number') {
    if (raw === 0) return null;
    if (!Number.isFinite(raw)) return null;
    if (Number.isInteger(raw) && raw > 0) return raw;
    return undefined;
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === '' || s === 'off' || s === 'unlimited' || s === 'infinity' || s === 'inf' || s === 'null') {
      return null;
    }
    if (!/^\d+$/.test(s)) return undefined;
    const n = Number(s);
    if (n === 0) return null;
    return n;
  }
  return undefined;
}

/**
 * option > session.metadata > loop_settings KV > unlimited (null).
 */
export function resolveInboxOverflowCap(input: {
  option?: number | null;
  sessionMetadata?: Record<string, unknown>;
  store?: InboxOverflowSettingsStore;
}): number | null {
  if (input.option !== undefined) {
    const fromOption = parseInboxOverflowCap(input.option);
    if (fromOption !== undefined) return fromOption;
  }
  const fromSession = parseInboxOverflowCap(input.sessionMetadata?.inboxOverflowCap);
  if (fromSession !== undefined) return fromSession;
  const saved = input.store?.getDaemonControl?.(LOOP_SETTINGS_KV_KEY);
  if (saved && typeof saved === 'object') {
    const fromKv = parseInboxOverflowCap((saved as Record<string, unknown>).inboxOverflowCap);
    if (fromKv !== undefined) return fromKv;
  }
  return DEFAULT_INBOX_OVERFLOW_CAP;
}

/**
 * Oldest items to claim/drop so that after inserting one summary,
 * unclaimed.length === cap. Empty when cap is off or not exceeded.
 */
export function planInboxOverflow<T>(unclaimed: readonly T[], cap: number | null | undefined): T[] {
  if (cap == null || !Number.isInteger(cap) || cap <= 0) return [];
  if (unclaimed.length <= cap) return [];
  const foldCount = unclaimed.length - cap + 1;
  return unclaimed.slice(0, foldCount) as T[];
}

export function summarizeInboxOverflow(
  items: ReadonlyArray<Pick<InboxItem, 'role' | 'text' | 'target' | 'contextParts' | 'key'>>
): string {
  let summary = `${INBOX_OVERFLOW_PREFIX} ${items.length} older unclaimed item(s) summarized (drop=summarize):`;
  const neutralize = (text: string) => text.replaceAll('«end external»', '‹end external›').replaceAll('«external', '‹external');
  for (const [index, item] of items.entries()) {
    const line = `${index + 1}. [${item.role ?? 'user'}/${item.target ?? 'next-step'}] ${clip(neutralize(item.text ?? ''), ITEM_TEXT_MAX)}`;
    const remaining = SUMMARY_MAX - summary.length - 1;
    if (remaining <= 0) break;
    // Re-folded summaries may themselves contain attachment excerpts. Keep their boundary intact.
    if (item.key !== INBOX_OVERFLOW_KEY) summary += '\n' + clip(line, remaining);
    const excerpts = item.key === INBOX_OVERFLOW_KEY ? [item.text] : (item.contextParts ?? []).flatMap(part => {
      if (!part.contextSources?.length) return [part.text];
      return part.contextSources.flatMap(source => source.kind === 'file'
        ? [source.name + '\n' + source.text]
        : source.entries.length ? source.entries.map(entry => source.name + '/' + entry.path + '\n' + entry.text) : [source.name]);
    });
    if (!excerpts.length) continue;
    const start = '\n«external source=attachment label="inbox excerpt"»\n';
    const end = '\n«end external»';
    const budget = Math.min(480, SUMMARY_MAX - summary.length - start.length - end.length);
    if (budget <= 0) continue;
    // Clip the body before adding delimiters, never clip away the closing fence.
    summary += start + clip(neutralize(excerpts.join('\n')), budget) + end;
  }
  return summary;
}

/**
 * Fold overflow into one system inbox. No-op when cap is off / not exceeded.
 * Caller must enqueue the triggering item *before* calling this.
 */
export function applyInboxOverflow(
  host: InboxOverflowHost,
  sessionId: string,
  cap: number | null | undefined
): InboxItem | undefined {
  const fold = planInboxOverflow(host.listUnclaimed(sessionId), cap);
  if (fold.length === 0) return undefined;
  host.markClaimed(fold.map((item) => item.id));
  return host.enqueueSummary(sessionId, summarizeInboxOverflow(fold), {
    target: 'next-step',
    role: 'system',
    key: INBOX_OVERFLOW_KEY
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
