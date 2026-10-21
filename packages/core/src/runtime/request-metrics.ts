import { randomUUID } from 'node:crypto';
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from '../types.js';
import { estimateNormalRequestTokens } from '../session/normal-request-budget.js';
import { resolveBotContextTokens, type ContextSettingsStore } from '../session/history/window.js';
import { splitCumulativePromptTokens } from '../model/usage.js';

export interface RequestMetrics {
  requestId: string;
  sessionId: string;
  sentAt: string;
  estimatedTokens: number;
  windowTokens: number;
  actualInputTokens?: number;
}

const usageByStore = new WeakMap<ContextSettingsStore, Map<string, { cumulative: number; sticky: boolean }>>();

export function observeModelRequests(store: ContextSettingsStore, adapter: ModelAdapter, previousUsage: Map<string, { cumulative: number; sticky: boolean }>): ModelAdapter {
  let usageHistory = usageByStore.get(store);
  if (!usageHistory) { usageHistory = new Map(); usageByStore.set(store, usageHistory); }
  const record = async (input: ModelTurnInput, send: () => Promise<ModelTurnResult>) => {
    const sid = input.sessionId;
    if (!sid) return send();
    const key = `session.latestRequest:${sid}`;
    const metric: RequestMetrics = { requestId: randomUUID(), sessionId: sid, sentAt: new Date().toISOString(), estimatedTokens: estimateNormalRequestTokens(input), windowTokens: resolveBotContextTokens(store, adapter) };
    try { store.setDaemonControl?.(key, metric); } catch { /* Observation must not block delivery. */ }
    const result = await send();
    try {
      if (result.usage?.requests === 1 && store.getDaemonControl<RequestMetrics>(key)?.requestId === metric.requestId) {
        const previous = usageHistory!.get(sid) ?? previousUsage.get(sid);
        const split = splitCumulativePromptTokens(result.usage.inputTokens, previous?.cumulative, previous?.sticky ?? false);
        usageHistory!.set(sid, { cumulative: split.cumulativeInputTokens, sticky: (previous?.sticky ?? false) || split.treatedAsCumulative });
        store.setDaemonControl?.(key, { ...metric, actualInputTokens: split.turnInputTokens });
      }
    } catch { /* Observation must not change a successful response. */ }
    return result;
  };
  const observed = Object.create(adapter) as ModelAdapter;
  observed.runTurn = input => record(input, () => adapter.runTurn(input));
  if (adapter.runTurnStream) observed.runTurnStream = (input, chunk) => record(input, () => adapter.runTurnStream!(input, chunk));
  return observed;
}
