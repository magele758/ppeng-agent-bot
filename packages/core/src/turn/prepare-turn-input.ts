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
import { copyView, messageViewKey, readPrepareSlice, writePrepareSlice } from './startup-input-cache.js';

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
  emitTrace?: (sessionId: string, event: { kind: string; payload: Record<string, unknown> }) => void;
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

function traceStartup(
  deps: PrepareTurnInputDeps,
  sessionId: string,
  payload: Record<string, unknown>
): void {
  try {
    void deps.emitTrace?.(sessionId, { kind: 'startup_phase', payload });
  } catch {
    /* tracing must not fail the turn */
  }
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
  const started = Date.now();
  const session = deps.store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const compactStarted = Date.now();
  await deps.autoCompact(session);
  traceStartup(deps, sessionId, {
    phase: 'auto_compact',
    scope: 'prepare',
    durationMs: Date.now() - compactStarted
  });

  const claimedInbox = deps.claimNextStep(sessionId);
  if (claimedInbox.length > 0) {
    applyClaimedInbox(deps.store, sessionId, claimedInbox);
  }

  const foldStarted = Date.now();
  const raw = deps.store.foldMessages(sessionId);
  const foldDurationMs = Date.now() - foldStarted;
  const sealStarted = Date.now();
  sealSharedExposure(deps.store, sessionId, raw);
  traceStartup(deps, sessionId, {
    phase: 'seal_exposure',
    scope: 'prepare',
    durationMs: Date.now() - sealStarted,
    messageCount: raw.length
  });
  const embedStarted = Date.now();
  const folded = embedReplyQuotes(raw.filter(message => sharedMessageVisible(deps.store, sessionId, message)), (messageId) => {
    const original = deps.store.readHistoryById?.(sessionId, messageId);
    return original && sharedMessageVisible(deps.store, sessionId, original) ? original : undefined;
  });
  traceStartup(deps, sessionId, {
    phase: 'embed_quotes',
    scope: 'prepare',
    durationMs: Date.now() - embedStarted,
    messageCount: folded.length
  });
  const foldSeqs = folded.map((m) => m.seq).filter((s): s is number => typeof s === 'number');
  const foldPayload: Record<string, unknown> = {
    phase: 'fold_messages',
    scope: 'prepare',
    durationMs: foldDurationMs,
    messageCount: folded.length
  };
  if (foldSeqs.length > 0) {
    foldPayload.hiddenCount = Math.max(...foldSeqs) - Math.min(...foldSeqs) + 1 - folded.length;
  }
  traceStartup(deps, sessionId, foldPayload);
  const budgetStarted = Date.now();
  const budgeted = deps.applyFoldBudget ? deps.applyFoldBudget(session, folded) : folded;
  traceStartup(deps, sessionId, {
    phase: 'fold_budget',
    scope: 'prepare',
    durationMs: Date.now() - budgetStarted,
    messageCount: budgeted.length
  });
  const viewKey = messageViewKey(budgeted);
  const cached = readPrepareSlice(sessionId);
  let prepared: SessionMessage[];
  if (cached?.viewKey === viewKey) {
    prepared = copyView(cached.view);
  } else {
    const viewStarted = Date.now();
    prepared = await deps.prepareView(session, budgeted);
    traceStartup(deps, sessionId, {
      phase: 'prepare_view',
      scope: 'prepare',
      durationMs: Date.now() - viewStarted,
      messageCount: prepared.length
    });
  }
  const query = lastUserQueryFromMessages(prepared);
  const appendixKey = `${viewKey}\0${query}\0${session.summary ?? ''}\0${session.updatedAt}`;
  let appendix: string;
  if (cached?.appendixKey === appendixKey) {
    appendix = cached.appendix;
  } else {
    const appendixStarted = Date.now();
    appendix = await Promise.resolve(
      deps.buildAppendix(session, { query, viewMessages: prepared })
    );
    traceStartup(deps, sessionId, {
      phase: 'memory_appendix',
      scope: 'prepare',
      durationMs: Date.now() - appendixStarted,
      messageCount: prepared.length
    });
  }
  writePrepareSlice(sessionId, { viewKey, view: copyView(prepared), appendixKey, appendix });
  const messages = applyMemoryAppendixToMessages(prepared, appendix);

  traceStartup(deps, sessionId, {
    phase: 'prepare_turn',
    scope: 'prepare',
    durationMs: Date.now() - started,
    messageCount: messages.length
  });

  return {
    session: deps.store.getSession(sessionId) ?? session,
    messages,
    viewMessages: prepared,
    foldSeqs,
    claimedInbox
  };
}
