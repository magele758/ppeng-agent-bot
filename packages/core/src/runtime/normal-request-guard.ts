/**
 * Apply the ordinary-session 20% request cap to the turn that is about to be
 * sent. Canonical bot chats return unchanged.
 */

import { createId, nowIso } from '../id.js';
import { isCanonicalBotChat } from '../session/bot-compact-policy.js';
import { capSystemPromptForTaskFacts } from '../session/task-context.js';
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
import { contextSourceNavigation, continuationSummaryInstruction } from '../session/context-sources.js';
import { estimateTokensFromText } from '../model/token-estimate.js';

export interface NormalRequestBudgetTrace {
  kind: 'request_over_budget' | 'compact_skipped' | 'compact';
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
    key: 'compact-summary',
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
    .flatMap((message) => message.replaces ? [message.replaces.startSeq, message.replaces.endSeq] : [message.seq])
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
  store.updateSession(session.id, { summary });
  if (deps.stateDir) await archiveMessages(deps.stateDir, session.id, prefix);
  deps.emitTrace?.({ kind: 'compact', payload: { replaced: { startSeq, endSeq }, didCompact: true, reason: 'request_budget' } });
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

  const systemPrompt = capSystemPromptForTaskFacts({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    messages: input.messages,
    maxContextTokens: deps.maxContextTokens
  });
  const prepared = systemPrompt === input.systemPrompt ? input : { ...input, systemPrompt };
  const fit = fitNormalSessionRequest({
    systemPrompt: prepared.systemPrompt,
    tools: prepared.tools,
    messages: prepared.messages,
    maxContextTokens: deps.maxContextTokens
  });

  if (fit.pinnedOverBudget) {
    deps.emitTrace?.(overBudgetTrace(fit, 'pinned'));
    return withMessages(prepared, fit.messages);
  }

  if (!fit.summarizePrefix || !fit.summaryKept) {
    if (fit.requestTokens > fit.capTokens) deps.emitTrace?.(overBudgetTrace(fit, 'unresolved'));
    const removed = prepared.messages.filter(message => !fit.messages.includes(message));
    return withMessages(prepared, addSourceNavigation(prepared, fit.messages, removed, fit.capTokens));
  }

  try {
    if (!deps.summarize) throw new Error('summary unavailable');
    const instruction = summaryMessage(deps.session?.id ?? prepared.sessionId ?? '', continuationSummaryInstruction(deps.session?.summary));
    const raw = await deps.summarize([...fit.summarizePrefix, instruction]);
    const keptTokens = estimateNormalRequestTokens({
      systemPrompt: prepared.systemPrompt,
      tools: prepared.tools,
      messages: fit.summaryKept
    });
    const room = fit.capTokens - keptTokens;
    if (!raw.trim()) throw new Error('empty summary');
    const source = contextSourceNavigation(fit.summarizePrefix);
    const sourceTokens = source ? estimateTokensFromText(source) + 2 : 0;
    const summary = capSummaryToTokens(raw, room - sourceTokens - 4);
    const text = summary && source ? `${summary}\n\n${source}` : capSummaryToTokens(raw, room - 4);
    if (!text) throw new Error('empty summary');
    const sessionId = deps.session?.id ?? prepared.sessionId ?? prepared.messages[0]?.sessionId ?? '';
    const messages = insertSummary(fit.summaryKept, summaryMessage(sessionId, text));
    const sentTokens = estimateNormalRequestTokens({
      systemPrompt: prepared.systemPrompt,
      tools: prepared.tools,
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
    return withMessages(prepared, messages);
  } catch (error) {
    deps.emitTrace?.({
      kind: 'compact_skipped',
      payload: {
        reason: 'summary_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    });
    if (fit.requestTokens > fit.capTokens) deps.emitTrace?.(overBudgetTrace(fit, 'summary_failed'));
    const removed = prepared.messages.filter(message => !fit.messages.includes(message));
    return withMessages(prepared, addSourceNavigation(prepared, fit.messages, removed, fit.capTokens));
  }
}

/** Navigation consumes the same request budget; never displace protected content for it. */
function addSourceNavigation(
  input: GuardedModelRequest, kept: SessionMessage[], removed: SessionMessage[], cap: number
): SessionMessage[] {
  const text = contextSourceNavigation(removed);
  if (!text) return kept;
  const source = { ...summaryMessage(input.sessionId ?? removed[0]?.sessionId ?? '', text), key: 'context-history-sources' };
  const candidate = insertSummary(kept, source);
  return estimateNormalRequestTokens({ ...input, messages: candidate }) <= cap ? candidate : kept;
}
