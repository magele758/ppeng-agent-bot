import { randomUUID } from 'node:crypto';
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from '../types.js';
import { estimateNormalRequestTokens } from '../session/normal-request-budget.js';
import { resolveBotContextTokens, type ContextSettingsStore } from '../session/history/window.js';
import { splitCumulativePromptTokens } from '../model/usage.js';
import { prepareSlotForRequest, rememberActualInput, rememberPrepareMetric } from './snapshot-request-metrics.js';

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
    const baseline = usageHistory!.get(sid) ?? previousUsage.get(sid);
    const metric: RequestMetrics = { requestId: randomUUID(), sessionId: sid, sentAt: new Date().toISOString(), estimatedTokens: estimateNormalRequestTokens(input), windowTokens: resolveBotContextTokens(store, adapter) };
    const slot = prepareSlotForRequest(store, sid, input.messages);
    try { store.setDaemonControl?.(key, metric); } catch { /* Observation must not block delivery. */ }
    if (slot) {
      try { rememberPrepareMetric(store, slot, metric); } catch { /* Observation must not block delivery. */ }
    }
    const result = await send();
    try {
      if (result.usage?.requests === 1) {
        const split = splitCumulativePromptTokens(result.usage.inputTokens, baseline?.cumulative, baseline?.sticky ?? false);
        if (store.getDaemonControl<RequestMetrics>(key)?.requestId === metric.requestId) {
          usageHistory!.set(sid, { cumulative: split.cumulativeInputTokens, sticky: (baseline?.sticky ?? false) || split.treatedAsCumulative });
          store.setDaemonControl?.(key, { ...metric, actualInputTokens: split.turnInputTokens });
        }
        if (slot) rememberActualInput(store, slot, metric.requestId, split.turnInputTokens);
      }
    } catch { /* Observation must not change a successful response. */ }
    return result;
  };
  const observed = Object.create(adapter) as ModelAdapter;
  observed.runTurn = input => record(input, () => adapter.runTurn(input));
  if (adapter.runTurnStream) observed.runTurnStream = (input, chunk) => record(input, () => adapter.runTurnStream!(input, chunk));
  return observed;
}
