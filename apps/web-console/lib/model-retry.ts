import type { ModelRetryProgress } from '../../../packages/agent-loop/src/types';

export type RetryProgress = ModelRetryProgress & { receivedAt: number };

export function readRetryProgress(value: unknown): RetryProgress | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as ModelRetryProgress;
  if (p.type !== 'model_retry' || !['waiting', 'requesting', 'switching', 'recovered', 'failed', 'cancelled'].includes(p.phase)
    || typeof p.model !== 'string' || typeof p.message !== 'string'
    || !Number.isFinite(p.retry) || !Number.isFinite(p.maxRetries) || !Number.isFinite(p.requests)) return;
  return { ...p, receivedAt: Date.now() };
}
