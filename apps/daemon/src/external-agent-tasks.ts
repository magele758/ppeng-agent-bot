import { createHash } from 'node:crypto';
import { AppError, AuthorizationError, NotFoundError, ValidationError, type RawAgentRuntime, type TaskRecord } from '@ppeng/agent-core';
import { objectBody, requiredText, type ExternalAgentClient } from './external-agent-settings.js';

interface HandoffIdentity { clientId: string; source: string; sourceTaskId: string }

function identity(task: TaskRecord): HandoffIdentity | undefined {
  return task.metadata.externalAgent as HandoffIdentity | undefined;
}

function taskStateReason(status: string, outcome?: { kind?: string; reason?: string }): string | undefined {
  if (status === 'waiting_approval') return 'human_approval_required';
  if (status === 'waiting_input') return 'human_input_required';
  if (status === 'unknown') return 'execution_state_unknown';
  if (status === 'failed') return outcome?.kind === 'failed' ? outcome.reason ?? status : status;
  if (status === 'cancelled') return outcome?.kind === 'aborted' ? outcome.reason ?? status : status;
  return undefined;
}

function waitingForInput(status: string, pending: unknown): boolean {
  return pending === true && ['queued', 'running', 'waiting_approval'].includes(status);
}

/** Expose task output/progress, never the full session, system prompts, tools or credentials. */
export function externalTaskView(runtime: RawAgentRuntime, client: ExternalAgentClient, id: string) {
  const task = runtime.getTask(id);
  if (!task || identity(task)?.clientId !== client.id) throw new NotFoundError('Task');
  const session = task.sessionId ? runtime.getSession(task.sessionId) : undefined;
  const outcome = session?.metadata.outcome as { kind?: string; reason?: string } | undefined;
  const pendingInput = session?.metadata.askUserPending;
  let status: string = task.status === 'in_progress' ? 'running' : task.status === 'pending' ? 'queued' : task.status;
  if (session?.status === 'running') status = 'running';
  if (session?.status === 'completed') status = 'completed';
  if (session?.status === 'failed' || outcome?.kind === 'failed') status = 'failed';
  if (session?.status === 'waiting_approval') status = 'waiting_approval';
  if (session?.status === 'unknown') status = 'unknown';
  if (outcome?.kind === 'aborted' || task.status === 'cancelled') status = 'cancelled';
  if (waitingForInput(status, pendingInput)) status = 'waiting_input';
  const reason = taskStateReason(status, outcome);
  return {
    id: task.id, title: task.title, agentId: task.ownerAgentId,
    source: identity(task)!.source, sourceTaskId: identity(task)!.sourceTaskId,
    status, reason, result: session ? runtime.getLatestAssistantText(session.id) ?? null : null,
    progress: session?.todo ?? [], artifacts: task.artifacts,
    createdAt: task.createdAt, updatedAt: session && session.updatedAt > task.updatedAt ? session.updatedAt : task.updatedAt
  };
}

export function submitExternalTask(runtime: RawAgentRuntime, client: ExternalAgentClient, input: unknown) {
  const body = objectBody(input);
  const source = requiredText(body.source, 'source', 160);
  const sourceTaskId = requiredText(body.sourceTaskId, 'sourceTaskId', 256);
  const goal = requiredText(body.goal, 'goal', 32000);
  const context = body.context === undefined ? '' : requiredText(body.context, 'context', 64000);
  const agentId = body.agentId === undefined ? client.defaultAgentId : requiredText(body.agentId, 'agentId', 160);
  if (!client.allowedAgentIds.includes(agentId)) throw new AuthorizationError('Executor is not allowed for this client');
  if (!runtime.store.getAgent(agentId)) throw new ValidationError('Executor is no longer available');
  const title = body.title === undefined ? goal.slice(0, 160) : requiredText(body.title, 'title', 160);
  const key = 'external_agent_task:' + createHash('sha256').update(JSON.stringify([client.id, source, sourceTaskId])).digest('hex');
  const store = runtime.store;
  // The lookup, creation and durable mapping share one write transaction, including across processes.
  store.db.exec('BEGIN IMMEDIATE');
  let taskId: string;
  let sessionId: string;
  try {
    const existing = store.getDaemonControl<{ taskId: string }>(key);
    if (existing) {
      if (!runtime.getTask(existing.taskId)) throw new AppError('HANDOFF_GONE', 'Previously accepted task was deleted; use a new sourceTaskId for new work', 410);
      store.db.exec('COMMIT');
      return { task: externalTaskView(runtime, client, existing.taskId), duplicate: true };
    }
    const externalAgent = { clientId: client.id, source, sourceTaskId };
    const metadata = { ...client.ownerMetadata, externalAgent };
    const created = runtime.createTaskSession({ title, description: goal, agentId, background: true,
      message: context ? `${goal}\n\nContext supplied by the delegating Agent:\n${context}` : goal, metadata });
    taskId = created.task.id;
    sessionId = created.session.id;
    store.updateTask(taskId, { metadata });
    store.setDaemonControl(key, { taskId });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  const task = externalTaskView(runtime, client, taskId);
  // A broken client connection cannot cancel accepted work. The existing scheduler
  // also sees persisted background task sessions after a daemon restart.
  setImmediate(() => {
    if (!store.db.isOpen) return;
    void runtime.runSession(sessionId).catch(() => {
      if (!store.db.isOpen) return;
      const current = runtime.getSession(sessionId);
      if (!current) return;
      store.updateSession(sessionId, { status: 'failed', metadata: { ...current.metadata,
        outcome: { kind: 'failed', reason: 'execution_failed', failureStage: 'host' } } });
      if (runtime.getTask(taskId)) store.updateTask(taskId, { status: 'failed' });
    });
  });
  return { task, duplicate: false };
}
