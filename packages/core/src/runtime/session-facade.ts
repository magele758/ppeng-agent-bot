/**
 * Session / task / mailbox façade extracted from RawAgentRuntime.
 * Create, send, permission, and latest-assistant helpers — no turn loop.
 */

import {
  describePermissionMode,
  parsePermissionMode,
  resolvePermissionMode,
  shiftPermissionMode,
  type PermissionMode
} from '../approval/permission-mode.js';
import { LEGACY_BOT_BYPASS_META } from '../bots/legacy-bypass.js';
import { APPROVAL_WAKE_KEY, disarmUnattendedApprovalExpiry } from '../approval/unattended-approval.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { textSummaryFromParts } from '../model/model-adapters.js';
import { decideSteerAdmission, type SteerAck } from '../session/steer-ack.js';
import { resolveSteerDrainPolicy, resolveSteerInboxTarget } from '../session/steer-drain.js';
import { resolveSteerInterruptPolicy } from '../session/steer-interrupt.js';
import type { EnqueueSteerOptions } from '../session/step-inbox.js';
import type { SqliteStateStore } from '../storage.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { inheritModelOverride } from './spawn-policy.js';
import { DYN_TOOL_PROMOTE_APPROVAL } from '../dyn-tools/types.js';
import type {
  AgentSpec,
  ApprovalRecord,
  ImagePart,
  MailRecord,
  MessagePart,
  SessionMessage,
  SessionRecord,
  TaskRecord
} from '../types.js';

export function textPart(text: string): MessagePart {
  return {
    type: 'text',
    text
  };
}

export function textFromMessage(message: SessionMessage): string {
  return textSummaryFromParts(message.parts);
}

export function userMessageParts(
  text: string,
  imageAssetIds: string[],
  store: SqliteStateStore
): MessagePart[] {
  const parts: MessagePart[] = [];
  const t = text.trim();
  if (t) parts.push(textPart(t));
  for (const id of imageAssetIds) {
    const asset = store.getImageAsset(id);
    if (!asset) continue;
    const im: ImagePart = {
      type: 'image',
      assetId: id,
      mimeType: asset.mimeType,
      sourceUrl: asset.sourceUrl,
      retentionTier: asset.retentionTier
    };
    parts.push(im);
  }
  return parts;
}

export interface SessionFacadeHost {
  store: SqliteStateStore;
  runImageRetention(sessionId: string): Promise<void>;
  wakeAllAutonomousSessions(reason: string): void;
  wakeAgentSessions(agentId: string, reason: string): void;
}

export function mergeSessionMetadata(
  store: SqliteStateStore,
  sessionId: string,
  patch: Record<string, unknown>
): SessionRecord {
  const s = store.getSession(sessionId);
  if (!s) {
    throw new NotFoundError('Session', sessionId);
  }
  return store.updateSession(sessionId, {
    metadata: { ...s.metadata, ...patch }
  });
}

export function getPermissionMode(store: SqliteStateStore, sessionId: string): PermissionMode {
  const s = store.getSession(sessionId);
  if (!s) throw new NotFoundError('Session', sessionId);
  return resolvePermissionMode(s.metadata, process.env);
}

export function setPermissionMode(
  store: SqliteStateStore,
  sessionId: string,
  input: { mode?: PermissionMode | string; shift?: 'elevate' | 'demote' }
): {
  sessionId: string;
  previous: PermissionMode;
  mode: PermissionMode;
  description: string;
} {
  const previous = getPermissionMode(store, sessionId);
  let next: PermissionMode | undefined;
  if (input.shift) {
    next = shiftPermissionMode(previous, input.shift);
  } else if (input.mode !== undefined) {
    next = parsePermissionMode(input.mode);
    if (!next) {
      throw new ValidationError(
        `Invalid permissionMode "${String(input.mode)}" (expected plan|ask|acceptEdits|auto|bypass)`
      );
    }
  } else {
    throw new ValidationError('Provide mode or shift=elevate|demote');
  }
  mergeSessionMetadata(store, sessionId, {
    permissionMode: next,
    permissionModeChangedAt: new Date().toISOString(),
    permissionModePrevious: previous,
    [LEGACY_BOT_BYPASS_META]: undefined
  });
  return {
    sessionId,
    previous,
    mode: next,
    description: describePermissionMode(next)
  };
}

export function ensureAgent(store: SqliteStateStore, agent: AgentSpec): AgentSpec {
  const existing = store.getAgent(agent.id);
  if (existing) {
    return existing;
  }
  store.upsertAgent(agent);
  return agent;
}

export function createChatSession(
  host: SessionFacadeHost,
  input: {
    title?: string;
    message?: string;
    imageAssetIds?: string[];
    agentId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }
): SessionRecord {
  const session = host.store.createSession({
    title: input.title ?? 'Chat Session',
    mode: 'chat',
    agentId: input.agentId?.trim() ? input.agentId.trim() : 'main',
    background: input.background ?? false,
    metadata: input.metadata
  });

  const ids = input.imageAssetIds?.filter(Boolean) ?? [];
  const msg = input.message?.trim() ?? '';
  if (msg || ids.length > 0) {
    host.store.appendMessage(session.id, 'user', userMessageParts(msg || '(image)', ids, host.store));
    void host.runImageRetention(session.id);
  }

  return session;
}

export function createTaskSession(
  host: SessionFacadeHost,
  input: {
    title: string;
    description?: string;
    message?: string;
    imageAssetIds?: string[];
    agentId?: string;
    blockedBy?: string[];
    background?: boolean;
    metadata?: Record<string, unknown>;
  }
): { task: TaskRecord; session: SessionRecord } {
  const task = host.store.createTask({
    title: input.title,
    description: input.description,
    ownerAgentId: input.agentId?.trim() ? input.agentId.trim() : 'main',
    blockedBy: input.blockedBy
  });
  host.wakeAllAutonomousSessions('task.created');

  const session = host.store.createSession({
    title: input.title,
    mode: 'task',
    agentId: input.agentId?.trim() ? input.agentId.trim() : 'main',
    taskId: task.id,
    background: input.background ?? true,
    metadata: {
      autoRun: true,
      ...(input.metadata ?? {})
    }
  });

  host.store.updateTask(task.id, { sessionId: session.id });
  const ids = input.imageAssetIds?.filter(Boolean) ?? [];
  if (input.message?.trim() || ids.length > 0) {
    const msg = input.message?.trim() ?? (ids.length ? '(image)' : '');
    host.store.appendMessage(session.id, 'user', userMessageParts(msg, ids, host.store));
    void host.runImageRetention(session.id);
  } else {
    host.store.appendMessage(
      session.id,
      'user',
      [textPart(`Work on task "${task.title}". ${task.description}`.trim())]
    );
  }

  return {
    task: host.store.getTask(task.id) as TaskRecord,
    session
  };
}

export const TEAMMATE_AGENT_ID_PREFIX = 'teammate:';

/**
 * Agent id for a teammate session. The name is model-chosen, so it must never resolve to an
 * existing non-teammate agent (a Bot's agent, a builtin): that would hand the teammate that
 * agent's memory namespace, instructions and tool allowlist. On such a collision the teammate
 * gets a prefixed id instead; ordinary names keep their id (mailboxes address teammates by it).
 */
export function teammateAgentId(store: SqliteStateStore, name: string): string {
  const trimmed = name.trim();
  const existing = store.getAgent(trimmed);
  if (existing?.capabilities?.includes('teammate')) return trimmed;
  const botTaken =
    store.getBot(trimmed) !== undefined ||
    store.listBots({ includeHidden: true }).some((bot) => bot.id === trimmed || bot.agentId === trimmed);
  return existing || botTaken ? `${TEAMMATE_AGENT_ID_PREFIX}${trimmed}` : trimmed;
}

export function createTeammateSession(
  host: SessionFacadeHost,
  input: {
    name: string;
    role: string;
    prompt: string;
    taskId?: string;
    parentSessionId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }
): SessionRecord {
  const agent = ensureAgent(host.store, {
    id: teammateAgentId(host.store, input.name),
    name: input.name,
    role: input.role,
    instructions: `You are teammate ${input.name}. ${input.role}. Check inbox, work on assigned tasks, and reply through send_message when handing off work.`,
    capabilities: ['teammate', 'tool-use', 'task-management'],
    autonomous: true
  });

  const parent = input.parentSessionId ? host.store.getSession(input.parentSessionId) : undefined;
  const session = host.store.createSession({
    title: `Teammate ${input.name}`,
    mode: 'teammate',
    agentId: agent.id,
    taskId: input.taskId,
    parentSessionId: input.parentSessionId,
    background: input.background ?? true,
    metadata: {
      autoRun: true,
      ...inheritModelOverride(parent?.metadata),
      ...(input.metadata ?? {})
    }
  });

  host.store.appendMessage(
    session.id,
    'user',
    [textPart(`${input.prompt}\n\nYou are teammate ${input.name}. Work asynchronously and use mailbox tools when needed.`)]
  );

  return session;
}

export function sendUserMessage(
  host: SessionFacadeHost,
  sessionId: string,
  message: string,
  options?: { imageAssetIds?: string[] }
): SessionRecord {
  const session = host.store.getSession(sessionId);
  if (!session) {
    throw new NotFoundError('Session', sessionId);
  }

  const ids = options?.imageAssetIds?.filter(Boolean) ?? [];
  const text = message.trim();
  if (!text && ids.length === 0) {
    throw new ValidationError('Message or imageAssetIds required');
  }
  host.store.appendMessage(session.id, 'user', userMessageParts(text || '(image)', ids, host.store));
  mergeSessionMetadata(host.store, session.id, {
    [APPROVAL_WAKE_KEY]: { kind: 'human', source: 'lab-chat' }
  });
  void host.runImageRetention(session.id);
  return host.store.getSession(session.id) as SessionRecord;
}

export function sendMailboxMessage(
  host: SessionFacadeHost,
  input: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    type?: string;
    correlationId?: string;
    sessionId?: string;
    taskId?: string;
  }
): MailRecord {
  if (!host.store.getAgent(input.fromAgentId)) {
    throw new NotFoundError('Agent', input.fromAgentId);
  }
  if (!host.store.getAgent(input.toAgentId)) {
    throw new NotFoundError('Agent', input.toAgentId);
  }

  const mail = host.store.createMail({
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    type: input.type ?? 'message',
    content: input.content,
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    taskId: input.taskId
  });
  host.wakeAgentSessions(input.toAgentId, 'mailbox');
  return mail;
}

export function enqueueSteer(
  store: SqliteStateStore,
  sessionId: string,
  text: string,
  opts?: EnqueueSteerOptions
): SteerAck {
  const session = store.getSession(sessionId);
  const policy = resolveSteerInterruptPolicy({
    option: opts?.interruptPolicy,
    sessionMetadata: session?.metadata,
    store
  });
  const decision = decideSteerAdmission({ session, text, interruptPolicy: policy });
  if (!decision.admit) {
    return { status: 'not_submitted', reason: decision.reason };
  }
  const drainPolicy = resolveSteerDrainPolicy({
    sessionMetadata: session?.metadata,
    store
  });
  const target = resolveSteerInboxTarget({
    explicitTarget: opts?.target,
    interruptPolicy: policy,
    drainPolicy,
    sessionStatus: session?.status
  });
  const item = store.enqueueSteer(sessionId, text.trim(), { ...opts, target });
  return { status: decision.status, item };
}

/** Latest visible assistant text (fold), not shadowed WAL originals. */
export function getLatestAssistantText(
  store: { foldMessages(sessionId: string): SessionMessage[] },
  sessionId: string
): string | undefined {
  const messages = store.foldMessages(sessionId);
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  return assistant ? textFromMessage(assistant) : undefined;
}

export async function approve(
  store: SqliteStateStore,
  approvalId: string,
  decision: 'approved' | 'rejected',
  opts?: {
    emitTrace?: (sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) => void;
  }
): Promise<ApprovalRecord> {
  const existing = store.getApproval(approvalId);
  if (!existing) {
    throw new NotFoundError('Approval', approvalId);
  }
  if (existing.status !== 'pending') return existing;
  const approval = store.updateApproval(approvalId, decision);
  if (approval.status !== decision) return approval;
  disarmUnattendedApprovalExpiry(approval.id);
  if (decision === 'approved' && approval.toolName === DYN_TOOL_PROMOTE_APPROVAL) {
    const name = typeof approval.args?.name === 'string' ? approval.args.name : '';
    const target = approval.args?.targetScope;
    if (name && (target === 'session.long' || target === 'project.memory')) {
      try {
        const dyn = tryCreateDynToolStore(store);
        dyn?.promote(name, approval.sessionId, target);
        opts?.emitTrace?.(approval.sessionId, {
          kind: 'dyn_tool_promote',
          payload: { name, targetScope: target }
        });
      } catch {
        /* fail-soft: approval still recorded */
      }
    }
  }
  const session = store.getSession(approval.sessionId);
  if (session && session.status === 'waiting_approval') {
    store.updateSession(session.id, { status: 'idle' });
    store.appendMessage(
      session.id,
      'user',
      [textPart(`Approval for ${approval.toolName} was ${decision}. Continue.`)]
    );
  }
  return approval;
}
