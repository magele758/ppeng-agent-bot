/**
 * Unique packing seam for one model shot.
 *
 * Order: autoCompact → claim next-step inbox → fold → quote context (full
 * original loaded by messageId) → view (images / refusal / micro-compact) →
 * memory / working-log appendix.
 *
 * ModelAdapter.runTurn must only receive `messages` from this function.
 */

import { createId } from '../id.js';
import type { MessageReplyTo, SessionMessage, SessionRecord } from '../types.js';
import type { InboxItem } from '../session/step-inbox.js';
import { lastUserQueryFromMessages } from '../session/context-compiler.js';
import { sealSharedExposure, sharedMessageVisible } from '../bots/shared-context-isolation.js';
import { embedReplyQuotes } from '../reply-quote.js';

export interface PrepareTurnInputStore {
  getSession(id: string): SessionRecord | undefined;
  foldMessages(sessionId: string): SessionMessage[];
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string,value: unknown): void;
  /** Load one stored message by id when the quote target is outside the fold. */
  readHistoryById?(sessionId: string, messageId: string): SessionMessage | undefined;
  appendMessage(
    sessionId: string,
    role: SessionMessage['role'],
    parts: SessionMessage['parts'],
    opts?: { key?: string; replyTo?: MessageReplyTo }
  ): SessionMessage;
  hideByKey(sessionId: string, key: string): number;
}

export interface PrepareTurnInputDeps {
  store: PrepareTurnInputStore;
  autoCompact: (session: SessionRecord) => Promise<void>;
  claimNextStep: (sessionId: string) => InboxItem[];
  prepareView: (session: SessionRecord, messages: SessionMessage[]) => Promise<SessionMessage[]>;
  buildAppendix: (
    session: SessionRecord,
    pack?: { query: string; viewMessages: SessionMessage[] }
  ) => string | Promise<string>;
  applyFoldBudget?: (session: SessionRecord, folded: SessionMessage[]) => SessionMessage[];
}

export interface PreparedTurnInput {
  session: SessionRecord;
  /** After appendix — this is what ModelAdapter.runTurn receives. */
  messages: SessionMessage[];
  /** Fold + view, before appendix (prompt-builder / cache-stable history). */
  viewMessages: SessionMessage[];
  foldSeqs: number[];
  claimedInbox: InboxItem[];
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
  items: InboxItem[]
): void {
  for (const item of items) {
    if (item.key) store.hideByKey(sessionId, item.key);
    store.appendMessage(sessionId, item.role, [textPart(item.text), ...(item.contextParts ?? [])], { ...(item.key ? {key:item.key} : {}), ...(item.replyTo ? {replyTo:item.replyTo} : {}) });
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

  const raw = deps.store.foldMessages(sessionId);
  sealSharedExposure(deps.store, sessionId, raw);
  const folded = embedReplyQuotes(raw.filter(message => sharedMessageVisible(deps.store, sessionId, message)), (messageId) => {
    const original = deps.store.readHistoryById?.(sessionId, messageId);
    return original && sharedMessageVisible(deps.store, sessionId, original) ? original : undefined;
  });
  const budgeted = deps.applyFoldBudget ? deps.applyFoldBudget(session, folded) : folded;
  const prepared = await deps.prepareView(session, budgeted);
  const query = lastUserQueryFromMessages(prepared);
  const appendix = await Promise.resolve(
    deps.buildAppendix(session, { query, viewMessages: prepared })
  );
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
