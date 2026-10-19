/**
 * Unique packing seam for one model shot.
 *
 * Order: autoCompact → claim next-step inbox → fold → fold-budget clamp →
 * view (refusal / micro-compact) → memory appendix (view copy only, no WAL).
 * Empty compiled appendix falls back to working-log tail; still view-only.
 */

import { createId } from '../helpers.js';
import type { MessageReplyTo } from '../types.js';
import type { SessionMessage, SessionRecord } from '../types.js';

export const WORKING_LOG_APPENDIX_HEAD =
  '[working log — durable trail across compaction; full transcripts at the referenced paths]';

export function formatWorkingLogAppendix(tail: string): string {
  const trimmed = tail.trim();
  return trimmed ? `${WORKING_LOG_APPENDIX_HEAD}\n${trimmed}` : '';
}

export function resolvePackedAppendix(compiled: string, workingLogTail = ''): string {
  return compiled.trim() ? compiled : formatWorkingLogAppendix(workingLogTail);
}

export interface PrepareTurnInputStore {
  getSession(id: string): SessionRecord | undefined;
  foldMessages(sessionId: string): SessionMessage[];
  appendMessage(
    sessionId: string,
    role: SessionMessage['role'],
    parts: SessionMessage['parts'],
    opts?: { key?: string; replyTo?: MessageReplyTo }
  ): SessionMessage;
  hideByKey?(sessionId: string, key: string): number;
}

export interface ClaimedInboxItem {
  key?: string;
  role: 'user' | 'system';
  text: string;
  replyTo?: MessageReplyTo;
  contextParts?: import('@ppeng/api-types').TextPart[];
}

export interface PrepareTurnInputDeps {
  store: PrepareTurnInputStore;
  autoCompact: (session: SessionRecord) => Promise<void>;
  claimNextStep: (sessionId: string) => ClaimedInboxItem[];
  prepareView: (session: SessionRecord, messages: SessionMessage[]) => Promise<SessionMessage[]>;
  buildAppendix: (
    session: SessionRecord,
    pack?: { query: string; viewMessages: SessionMessage[] }
  ) => string | Promise<string>;
  applyFoldBudget?: (session: SessionRecord, folded: SessionMessage[]) => SessionMessage[];
  /**
   * Optional working-log tail reader (full+). Injected so mini/pack never
   * statically import `node:fs`. Called only when `buildAppendix` is empty.
   */
  readWorkingLogTail?: (sessionId: string) => string;
}

export interface PreparedTurnInput {
  session: SessionRecord;
  /** After appendix — this is what the model receives. */
  messages: SessionMessage[];
  /** Fold + view, before appendix (prompt-builder / cache-stable history). */
  viewMessages: SessionMessage[];
  foldSeqs: number[];
  claimedInbox: ClaimedInboxItem[];
}

export function lastUserQueryFromMessages(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const texts = m.parts
      .filter((p): p is Extract<(typeof m.parts)[number], { type: 'text' }> => p.type === 'text')
      .map((p) => p.text.trim())
      .filter(Boolean);
    if (texts.length > 0) return texts[texts.length - 1]!;
  }
  return '';
}

export function applyMemoryAppendixToMessages(
  messages: SessionMessage[],
  appendix: string
): SessionMessage[] {
  if (!appendix.trim()) return messages;
  const out = messages.map((m) => ({ ...m, parts: [...m.parts] }));
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    return [
      {
        id: createId('msg'),
        sessionId: messages[0]?.sessionId ?? '',
        role: 'user',
        parts: [{ type: 'text', text: appendix }],
        createdAt: new Date().toISOString()
      },
      ...out
    ];
  }
  const msg = out[idx]!;
  out[idx] = {
    ...msg,
    parts: [{ type: 'text', text: `${appendix}\n\n` }, ...msg.parts]
  };
  return out;
}

function textPart(text: string): SessionMessage['parts'][number] {
  return { type: 'text', text };
}

export function applyClaimedInbox(
  store: PrepareTurnInputStore,
  sessionId: string,
  items: ClaimedInboxItem[]
): void {
  for (const item of items) {
    if (item.key) store.hideByKey?.(sessionId, item.key);
    store.appendMessage(
      sessionId,
      item.role,
      [textPart(item.text), ...(item.contextParts ?? [])],
      { ...(item.key ? { key: item.key } : {}), ...(item.replyTo ? { replyTo: item.replyTo } : {}) }
    );
  }
}

export async function prepareTurnInput(
  sessionId: string,
  deps: PrepareTurnInputDeps
): Promise<PreparedTurnInput> {
  const session = deps.store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  await deps.autoCompact(session);

  const claimedInbox = deps.claimNextStep(sessionId);
  if (claimedInbox.length > 0) {
    applyClaimedInbox(deps.store, sessionId, claimedInbox);
  }

  const folded = deps.store.foldMessages(sessionId);
  const budgeted = deps.applyFoldBudget ? deps.applyFoldBudget(session, folded) : folded;
  const prepared = await deps.prepareView(session, budgeted);
  const query = lastUserQueryFromMessages(prepared);
  const compiled = await Promise.resolve(
    deps.buildAppendix(session, { query, viewMessages: prepared })
  );
  const workingLogTail =
    !compiled.trim() && deps.readWorkingLogTail ? deps.readWorkingLogTail(sessionId) : '';
  const appendix = resolvePackedAppendix(compiled, workingLogTail);
  const messages = applyMemoryAppendixToMessages(prepared, appendix);
  const foldSeqs = folded.map((m) => m.seq).filter((s): s is number => typeof s === 'number');

  return {
    session: deps.store.getSession(sessionId) ?? session,
    messages,
    viewMessages: prepared,
    foldSeqs,
    claimedInbox
  };
}
