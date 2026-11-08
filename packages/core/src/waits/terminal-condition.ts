import { stableJson } from '../cron/notification-decision.js';
import type { DurableWait, WaitCondition } from './types.js';

const terminalStatuses = ['completed', 'failed', 'cancelled', 'unknown', 'expired', 'rejected', 'timed_out'];

export function terminalObservableCondition(source: string): WaitCondition {
  const status: WaitCondition = { op: 'in', field: 'status', values: [...terminalStatuses] };
  if (source === 'session' || source === 'bot_task') return status;
  return { op: 'all', conditions: [status, { op: 'changed', field: 'version' }] };
}

const legacyBotCondition = stableJson({
  op: 'all', conditions: [terminalObservableCondition('bot_task'), { op: 'changed', field: 'version' }]
});

/** Old host-generated waits sometimes captured the final version as their starting baseline. */
export function decodeStoredWait(payload: string): DurableWait {
  const wait: DurableWait = JSON.parse(payload);
  if (wait.hostRegistered && wait.spec.source === 'bot_task' && stableJson(wait.spec.condition) === legacyBotCondition) {
    wait.spec.condition = terminalObservableCondition('bot_task');
  }
  return wait;
}
