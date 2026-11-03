import { decideRecovery } from '../../session/durable-recovery.js';
import { latestCheckpoint } from '../../session/checkpoint.js';
import type { BotGoalService } from './service.js';
import type { BotGoal, GoalExecution } from './types.js';
import type { GoalRuntimeHost } from './runtime-host.js';

function waitingOnDurableWait(goal: BotGoal): boolean {
  return goal.status === 'waiting' && goal.wait?.source === 'durable_wait';
}

function effectsUnverified(host: GoalRuntimeHost, sessionId: string | undefined, startedAt: string): boolean {
  if (!sessionId || !host.hasUnconfirmedEffects) return true;
  return host.hasUnconfirmedEffects(sessionId, startedAt);
}

function recoveryInput(host: GoalRuntimeHost, execution: GoalExecution) {
  const sessionId = execution.sessionId;
  const session = sessionId ? host.store.getSession(sessionId) : undefined;
  const messages = sessionId ? host.store.foldMessages(sessionId) : [];
  return {
    checkpoint: latestCheckpoint(session?.metadata),
    messages,
    hasUnconfirmedEffects: effectsUnverified(host, sessionId, execution.startedAt)
  };
}

function checkpointResumeStep(): string {
  return 'Inspect the retained checkpoint and continue from it. Do not repeat operations whose result is unknown.';
}

export function settleDeadGoalExecution(host: GoalRuntimeHost, service: BotGoalService, botId: string, goal: BotGoal, execution: GoalExecution): void {
  if (waitingOnDurableWait(goal)) return;
  if (decideRecovery(recoveryInput(host, execution)).resume) {
    service.resumeInterruptedCheckpoint(botId, execution.id, checkpointResumeStep());
    return;
  }
  service.recoverInterruptedExecution(botId, execution.id);
}
