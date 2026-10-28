import { createHash } from 'node:crypto';
import { AppError, AuthorizationError, NotFoundError, ValidationError, SourceLedger, botWorkControl, resolveBotPrincipal, type RawAgentRuntime, type TaskRecord } from '@ppeng/agent-core';
import { objectBody, requiredText, type ExternalAgentClient } from './external-agent-settings.js';

interface HandoffIdentity { clientId: string; source: string; sourceTaskId: string; botId?: string }

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
  if (identity(task)?.botId && !client.allowedBotIds?.includes(identity(task)!.botId!)) throw new NotFoundError('Task');
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
    botId: identity(task)!.botId, source: identity(task)!.source, sourceTaskId: identity(task)!.sourceTaskId,
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
  const botId = body.botId === undefined ? undefined : requiredText(body.botId, 'botId', 160);
  if (botId && body.agentId !== undefined) throw new ValidationError('Choose botId or agentId');
  if (botId && !client.allowedBotIds?.includes(botId)) throw new AuthorizationError('Bot is not allowed for this client');
  let botMetadata: Record<string, unknown> = {};
  if (botId) {
    const opened = runtime.openBot(botId, { userId: typeof client.ownerMetadata.userId === 'string' ? client.ownerMetadata.userId : undefined, tenantId: typeof client.ownerMetadata.tenantId === 'string' ? client.ownerMetadata.tenantId : undefined });
    const saved = runtime.getSession(opened.sessionId)!.metadata;
    // Copy execution policy only. Canonical chat flags, history, secret refs, wake state and outcomes are private.
    for (const field of ['userId', 'tenantId', 'permissionMode', 'allowedTools', 'allowedSkills', 'maxTurns', 'modelOverride', 'workspaceBinding', 'workspaceBindingBound', 'workspaceId', 'persona', 'enabledOptionalToolGroups']) {
      if (saved[field] !== undefined) botMetadata[field] = saved[field];
    }
    const control = botWorkControl(runtime.store, resolveBotPrincipal(runtime.store, {userId: typeof saved.userId === 'string' ? saved.userId : undefined, tenantId: typeof saved.tenantId === 'string' ? saved.tenantId : undefined}), botId);
    if (control.paused || control.disabled) throw new AuthorizationError('Bot is paused or disabled');
    botMetadata.botId = botId;
  }
  const agentId = botId ?? (body.agentId === undefined ? client.defaultAgentId : requiredText(body.agentId, 'agentId', 160));
  if (!botId && !client.allowedAgentIds.includes(agentId)) throw new AuthorizationError('Executor is not allowed for this client');
  if (!botId && runtime.store.getBot(agentId)) throw new AuthorizationError('Use an explicit authorized botId for Bot tasks');
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
    const externalAgent = { clientId: client.id, source, sourceTaskId, ...(botId ? {botId} : {}) };
    const metadata = { ...client.ownerMetadata, ...botMetadata, externalAgent, approvalWake: {kind: 'unattended', source: 'external-agent'} };
    const created = runtime.createTaskSession({ title, description: goal, agentId, background: true,
      message: context ? `${goal}\n\nContext supplied by the delegating Agent:\n${context}` : goal, metadata });
    taskId = created.task.id;
    sessionId = created.session.id;
    store.updateTask(taskId, { metadata });
    if (botId) new SourceLedger(store).record(sessionId, {kind: 'event', ref: `external-agent:${client.id}:${taskId}`, label: 'external Agent task'});
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
    if (!store.db.isOpen || runtime.getTask(taskId)?.status === 'cancelled') return;
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

/** Scoped continuation supplies data only; it cannot grant a pending tool approval. */
export function externalTaskAction(runtime: RawAgentRuntime, client: ExternalAgentClient, id: string, action: 'cancel' | 'input', input: unknown) {
  const current = externalTaskView(runtime, client, id);
  const task = runtime.getTask(id)!;
  if (!task.sessionId) throw new ValidationError('Task execution unavailable');
  if (action === 'cancel') {
    if (!['completed','failed','cancelled'].includes(current.status)) {
      runtime.cancelSession(task.sessionId);
      runtime.store.updateTask(id, {status: 'cancelled'});
    }
    return externalTaskView(runtime, client, id);
  }
  const body = objectBody(input);
  const message = requiredText(body.message, 'message', 32000);
  const inputId = requiredText(body.inputId, 'inputId', 256);
  const key = 'external_agent_input:' + createHash('sha256').update(JSON.stringify([client.id, id, inputId])).digest('hex');
  runtime.store.db.exec('BEGIN IMMEDIATE');
  try {
    const previous = runtime.store.getDaemonControl<{message: string}>(key);
    if (previous) {
      if (previous.message !== message) throw new ValidationError('inputId already used with different input');
      runtime.store.db.exec('COMMIT');
      return externalTaskView(runtime, client, id);
    }
    if (current.status !== 'waiting_input') throw new ValidationError('Task is not waiting for input');
    const session = runtime.getSession(task.sessionId)!;
    runtime.store.appendMessage(session.id, 'user', [{type: 'text', text: message}]);
    runtime.mergeSessionMetadata(session.id, {askUserReply: message, askUserPending: false, approvalWake: {kind:'unattended',source:'external-agent'}});
    runtime.store.setDaemonControl(key, {message});
    runtime.store.db.exec('COMMIT');
  } catch (error) {runtime.store.db.exec('ROLLBACK'); throw error;}
  setImmediate(() => { if (runtime.store.db.isOpen && runtime.getTask(id)?.status !== 'cancelled') void runtime.runSession(task.sessionId!).catch(() => {}); });
  return externalTaskView(runtime, client, id);
}
