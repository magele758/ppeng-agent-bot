/**
 * Snapshots of the prepared model view, taken when a turn is about to send.
 *
 * Recording only copies kind, label, token estimate, and text. It does not
 * compact the session or write a summary. Replay reads the stored rows.
 */

import { isMemoryContextAppendixText } from '../memory/memory-gate.js';
import type { ModelAdapter, SessionMessage, SessionRecord } from '../types.js';
import { isCanonicalBotChat } from './bot-compact-policy.js';
import {
  assembleContextStack,
  describeContextBudget,
  type ContextAppendixView,
  type ContextBlockDisposition
} from './context-stack.js';
import { resolveBotWindowBudget } from './history/window.js';
import { estimateToolSchemaTokens, type CountedToolSchema } from './normal-request-budget.js';
import { resolveMaxContextTokens } from './session-budget.js';

export interface ContextSnapshotBlock {
  id: string;
  kind: string;
  label: string;
  tokens: number;
  text: string;
  chars: number;
  pinned: boolean;
  disposition: ContextBlockDisposition;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  /** 1-based order within the session. Not the in-run loop counter. */
  turn: number;
  createdAt: string;
  blocks: ContextSnapshotBlock[];
  /** Send-time estimate for this prepare. Absent when that send was not metered. */
  estimatedTokens?: number;
  windowTokens?: number;
  /** Upstream input tokens for this send. Omitted when the provider did not report them. */
  actualInputTokens?: number;
  sentAt?: string;
}

export interface ContextSnapshotWriteStore {
  appendContextSnapshot?(sessionId: string, blocks: readonly ContextSnapshotBlock[]): ContextSnapshot;
  getDaemonControl?<T>(key: string): T | undefined;
}

export function contextSnapshotFingerprint(
  blocks: readonly Pick<ContextSnapshotBlock, 'kind' | 'label' | 'tokens' | 'text'>[]
): string {
  return JSON.stringify(blocks.map((block) => [block.kind, block.label, block.tokens, block.text]));
}

export function parseContextSnapshotBlocks(raw: unknown): ContextSnapshotBlock[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const blocks: ContextSnapshotBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text : '';
    const tokens = typeof row.tokens === 'number' && Number.isFinite(row.tokens) ? Math.max(0, row.tokens) : 0;
    const disposition: ContextBlockDisposition =
      row.disposition === 'summarize' || row.disposition === 'dropped' ? row.disposition : 'keep';
    blocks.push({
      id: typeof row.id === 'string' && row.id ? row.id : `block-${blocks.length}`,
      kind: typeof row.kind === 'string' && row.kind ? row.kind : 'user',
      label: typeof row.label === 'string' ? row.label : '',
      tokens,
      text,
      chars: text.length,
      pinned: row.pinned === true,
      disposition
    });
  }
  return blocks;
}

/** Earlier turns first. Same turn breaks ties by time, then id. */
export function orderContextSnapshots<T extends { turn: number; createdAt: string; id: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => {
    if (a.turn !== b.turn) return a.turn - b.turn;
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/** Returns the snapshot at `index` after the caller has ordered the list. */
export function selectContextSnapshot<T>(ordered: readonly T[], index: number): T | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= ordered.length) return undefined;
  return ordered[index];
}

function appendixFromPrepared(messages: readonly SessionMessage[]): ContextAppendixView | undefined {
  let message: SessionMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') {
      message = messages[i];
      break;
    }
  }
  if (!message) return undefined;
  const first = message.parts[0];
  if (!first || first.type !== 'text') return undefined;
  const stored = first.text;
  const text = stored.endsWith('\n\n') ? stored.slice(0, -2) : stored;
  if (!text.trim()) return undefined;
  if (text.startsWith('[working log')) {
    return { messageId: message.id, text, workingLog: true };
  }
  if (isMemoryContextAppendixText(text)) {
    return { messageId: message.id, text };
  }
  return undefined;
}

/** Blocks for one prepared request. Pure: no compact and no summary write. */
export function preparedContextSnapshotBlocks(input: {
  sessionId: string;
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: readonly SessionMessage[];
  mode: 'normal' | 'canonical-bot';
  maxContextTokens: number;
  botWindow?: {
    contextTokens: number;
    historyTokens: number;
    structuredTokens: number;
    hygieneTokens: number;
  };
}): ContextSnapshotBlock[] {
  const messages = [...input.messages];
  const described =
    input.mode === 'canonical-bot'
      ? describeContextBudget({
          mode: 'canonical-bot',
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          messages,
          maxContextTokens: input.maxContextTokens,
          botWindow: input.botWindow
        })
      : describeContextBudget({
          mode: 'normal',
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          messages,
          maxContextTokens: input.maxContextTokens
        });
  const payload = assembleContextStack({
    sessionId: input.sessionId,
    systemPrompt: described.systemPrompt,
    tools: input.tools,
    messages,
    appendix: appendixFromPrepared(messages),
    budget: described.budget,
    dispositionById: described.dispositionById,
    pinnedIds: new Set(described.pinnedIds)
  });
  return payload.blocks.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    tokens: item.tokens,
    text: item.text,
    chars: item.text.length,
    pinned: item.pinned,
    disposition: item.disposition
  }));
}

export type PreparedContextSnapshotInput = {
  session: Pick<SessionRecord, 'id' | 'metadata'>;
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: readonly SessionMessage[];
  adapter?: Partial<ModelAdapter> & { contextWindow?: number };
  env?: NodeJS.ProcessEnv;
};

/**
 * Blocks for a view a turn has already prepared. Pure: no append, compact, or
 * summary write. Callers that defer the SQLite write capture this before the
 * prepared messages can be edited in place.
 */
export function preparedContextSnapshotBlocksFor(
  store: ContextSnapshotWriteStore,
  input: PreparedContextSnapshotInput
): ContextSnapshotBlock[] {
  const env = input.env ?? process.env;
  const canonical = isCanonicalBotChat(input.session);
  const botWindow = canonical
    ? resolveBotWindowBudget(
        {
          getDaemonControl: <T>(key: string): T | undefined =>
            store.getDaemonControl ? (store.getDaemonControl(key) as T | undefined) : undefined
        },
        input.adapter ?? {},
        {
          systemPromptChars: input.systemPrompt.length,
          toolSchemaTokens: estimateToolSchemaTokens(input.tools)
        },
        env
      )
    : undefined;
  return preparedContextSnapshotBlocks({
    sessionId: input.session.id,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    messages: input.messages,
    mode: canonical ? 'canonical-bot' : 'normal',
    maxContextTokens: botWindow?.contextTokens ?? resolveMaxContextTokens(env),
    botWindow
  });
}

/**
 * Persist the view a turn has already prepared. Identical to the previous
 * snapshot is a no-op. Does not compact or summarize.
 */
export function recordPreparedContextSnapshot(
  store: ContextSnapshotWriteStore,
  input: PreparedContextSnapshotInput
): ContextSnapshot | undefined {
  if (!store.appendContextSnapshot) return undefined;
  return store.appendContextSnapshot(input.session.id, preparedContextSnapshotBlocksFor(store, input));
}
