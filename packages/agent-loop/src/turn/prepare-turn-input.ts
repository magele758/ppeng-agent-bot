import { applyClaimedInbox as applyInbox } from '../session/apply-claimed-inbox.js';
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
import { copyView, messageViewKey, readPrepareSlice, writePrepareSlice } from './startup-input-cache.js';

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
  /** Counts and durationMs only — never message text or secrets. */
  emitTrace?: (
    sessionId: string,
    event: { kind: string; payload: Record<string, unknown>; data?: Record<string, unknown> }
  ) => void;
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

function traceStartup(
  deps: PrepareTurnInputDeps,
  sessionId: string,
  payload: Record<string, unknown>
): void {
  try {
    deps.emitTrace?.(sessionId, { kind: 'startup_phase', payload, data: payload });
  } catch {
    /* tracing must not fail the turn */
  }
}

export function applyClaimedInbox(
  store: PrepareTurnInputStore,
  sessionId: string,
  items: ClaimedInboxItem[]
): void {
  applyInbox(store, sessionId, items);
}

export async function prepareTurnInput(
  sessionId: string,
  deps: PrepareTurnInputDeps
): Promise<PreparedTurnInput> {
  const turnStarted = Date.now();
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
  const folded = deps.store.foldMessages(sessionId);
  const seqs = folded.map((m) => m.seq).filter((s): s is number => typeof s === 'number');
  traceStartup(deps, sessionId, {
    phase: 'fold_messages',
    scope: 'prepare',
    durationMs: Date.now() - foldStarted,
    messageCount: folded.length,
    ...(seqs.length > 0
      ? { hiddenCount: Math.max(...seqs) - Math.min(...seqs) + 1 - folded.length }
      : {})
  });
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
    const compiled = await Promise.resolve(
      deps.buildAppendix(session, { query, viewMessages: prepared })
    );
    const workingLogTail =
      !compiled.trim() && deps.readWorkingLogTail ? deps.readWorkingLogTail(sessionId) : '';
    appendix = resolvePackedAppendix(compiled, workingLogTail);
    traceStartup(deps, sessionId, {
      phase: 'memory_appendix',
      scope: 'prepare',
      durationMs: Date.now() - appendixStarted,
      messageCount: prepared.length
    });
  }
  writePrepareSlice(sessionId, { viewKey, view: copyView(prepared), appendixKey, appendix });
  const messages = applyMemoryAppendixToMessages(prepared, appendix);
  const foldSeqs = folded.map((m) => m.seq).filter((s): s is number => typeof s === 'number');

  traceStartup(deps, sessionId, {
    phase: 'prepare_turn',
    scope: 'prepare',
    durationMs: Date.now() - turnStarted,
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
