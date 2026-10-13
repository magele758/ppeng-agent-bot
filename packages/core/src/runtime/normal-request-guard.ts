/**
 * Apply the ordinary-session 20% request cap to the turn that is about to be
 * sent. Canonical bot chats return unchanged.
 */

import { createId, nowIso } from '../id.js';
import { isCanonicalBotChat } from '../session/bot-compact-policy.js';
import {
  NORMAL_SESSION_REQUEST_RATIO,
  capSummaryToTokens,
  estimateNormalRequestTokens,
  fitNormalSessionRequest,
  type CountedToolSchema,
  type NormalRequestFit
} from '../session/normal-request-budget.js';
import type { SessionMessage } from '../types.js';
import { archiveMessages } from './compact-host.js';

export interface NormalRequestBudgetTrace {
  kind: 'request_over_budget' | 'compact_skipped';
  payload?: Record<string, unknown>;
}

export interface NormalRequestStore {
  appendReplacement(
    sessionId: string,
    input: {
      startSeq: number;
      endSeq: number;
      role: SessionMessage['role'];
      parts: SessionMessage['parts'];
      key?: string;
    }
  ): unknown;
  updateSession(sessionId: string, patch: { summary?: string }): unknown;
}

export interface NormalRequestGuardDeps {
  session?: { id: string; summary?: string; metadata?: Record<string, unknown> | null };
  store?: NormalRequestStore;
  stateDir?: string;
  maxContextTokens: number;
  summarize?: (messages: SessionMessage[]) => Promise<string>;
  emitTrace?: (event: NormalRequestBudgetTrace) => void;
}

export interface GuardedModelRequest {
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: SessionMessage[];
  sessionId?: string;
}

function overBudgetTrace(fit: NormalRequestFit, reason: string): NormalRequestBudgetTrace {
  return {
    kind: 'request_over_budget',
    payload: {
      reason,
      requestTokens: fit.requestTokens,
      capTokens: fit.capTokens,
      windowTokens: fit.windowTokens,
      pinnedTokens: fit.pinnedTokens,
      ratio: NORMAL_SESSION_REQUEST_RATIO
    }
  };
}

function summaryMessage(sessionId: string, text: string): SessionMessage {
  return {
    id: createId('msg'),
    sessionId,
    role: 'system',
    parts: [{ type: 'text', text }],
    createdAt: nowIso()
  };
}

function insertSummary(kept: readonly SessionMessage[], summary: SessionMessage): SessionMessage[] {
  let index = 0;
  while (index < kept.length && kept[index]!.role === 'system') index += 1;
  return [...kept.slice(0, index), summary, ...kept.slice(index)];
}

async function persistSummary(
  deps: NormalRequestGuardDeps,
  prefix: SessionMessage[],
  summary: string
): Promise<void> {
  const session = deps.session;
  const store = deps.store;
  if (!session || !store) return;
  const seqs = prefix
    .map((message) => message.seq)
    .filter((seq): seq is number => typeof seq === 'number');
  if (seqs.length === 0) return;
  const startSeq = Math.min(...seqs);
  const endSeq = Math.max(...seqs);
  store.appendReplacement(session.id, {
    startSeq,
    endSeq,
    role: 'system',
    parts: [{ type: 'text', text: summary }],
    key: 'compact-summary'
  });
  const merged = session.summary ? `${session.summary}\n\n${summary}` : summary;
  store.updateSession(session.id, { summary: merged });
  if (deps.stateDir) await archiveMessages(deps.stateDir, session.id, prefix);
}

function withMessages<T extends GuardedModelRequest>(input: T, messages: SessionMessage[]): T {
  if (messages === input.messages) return input;
  return { ...input, messages };
}

export async function applyNormalSessionRequestBudget<T extends GuardedModelRequest>(
  input: T,
  deps: NormalRequestGuardDeps
): Promise<T> {
  if (deps.session && isCanonicalBotChat(deps.session)) return input;

  const fit = fitNormalSessionRequest({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    messages: input.messages,
    maxContextTokens: deps.maxContextTokens
  });

  if (fit.pinnedOverBudget) {
    deps.emitTrace?.(overBudgetTrace(fit, 'pinned'));
    return withMessages(input, fit.messages);
  }

  if (!fit.summarizePrefix || !fit.summaryKept) {
    if (fit.requestTokens > fit.capTokens) deps.emitTrace?.(overBudgetTrace(fit, 'unresolved'));
    return withMessages(input, fit.messages);
  }

  try {
    if (!deps.summarize) throw new Error('summary unavailable');
    const raw = await deps.summarize(fit.summarizePrefix);
    const keptTokens = estimateNormalRequestTokens({
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      messages: fit.summaryKept
    });
    const room = fit.capTokens - keptTokens;
    const text = capSummaryToTokens(raw, room - 4);
    if (!text) throw new Error('empty summary');
    const sessionId = deps.session?.id ?? input.sessionId ?? input.messages[0]?.sessionId ?? '';
    const messages = insertSummary(fit.summaryKept, summaryMessage(sessionId, text));
    const sentTokens = estimateNormalRequestTokens({
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      messages
    });
    try {
      await persistSummary(deps, fit.summarizePrefix, text);
    } catch (error) {
      deps.emitTrace?.({
        kind: 'compact_skipped',
        payload: {
          reason: 'persist_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
    if (sentTokens > fit.capTokens) {
      deps.emitTrace?.(
        overBudgetTrace({ ...fit, requestTokens: sentTokens }, 'summary_still_over')
      );
    }
    return withMessages(input, messages);
  } catch (error) {
    deps.emitTrace?.({
      kind: 'compact_skipped',
      payload: {
        reason: 'summary_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    });
    if (fit.requestTokens > fit.capTokens) deps.emitTrace?.(overBudgetTrace(fit, 'summary_failed'));
    return withMessages(input, fit.messages);
  }
}
