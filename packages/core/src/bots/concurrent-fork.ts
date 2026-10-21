/**
 * Canonical bot chats stay the coordinator. One in-flight turn runs on the
 * parent. Each additional pending human piece gets its own sub-agent.
 */

import type { SessionMessage, SessionRecord } from '../types.js';
import type { SqliteStateStore } from '../storage.js';
import { listPendingHumanWork } from '../session/human-continuation.js';
import { inheritBotIdentityMetadata } from '../memory/bot-memory-scope.js';
import { childPermissionMode, inheritBotAllowlists, inheritModelOverride } from '../runtime/spawn-policy.js';
import { forkOpeningMessage, inheritForkRetrievalMetadata, visibleTaskText } from './fork-inheritance.js';

export interface WorkPiece {
  id: string;
  text: string;
  /** Set when the source message carries images or attachment references but no visible text. */
  hasAttachment?: boolean;
}

export interface ConcurrentForkPlan {
  parentPieceId?: string;
  forks: WorkPiece[];
}

export interface ConcurrentForkRef {
  sourceMessageId: string;
  childSessionId: string;
  status: 'running' | 'idle' | 'failed';
}

export const CONCURRENT_FORKS_KEY = 'concurrentBotForks';
export const COORDINATOR_NOTE_PREFIX = '【协调】';

const activeWorkPiece = new Map<string, string>();

export function planConcurrentBotForks(input: {
  inFlight: boolean;
  activePieceId?: string;
  pending: readonly WorkPiece[];
}): ConcurrentForkPlan {
  const pending = input.pending.filter((piece) => piece.id && (piece.text.trim() || piece.hasAttachment));
  if (!input.inFlight) {
    if (pending.length <= 1) return { parentPieceId: pending[0]?.id, forks: [] };
    return { parentPieceId: pending[0]!.id, forks: pending.slice(1) };
  }
  if (input.activePieceId) {
    return {
      parentPieceId: input.activePieceId,
      forks: pending.filter((piece) => piece.id !== input.activePieceId)
    };
  }
  if (pending.length <= 1) return { parentPieceId: pending[0]?.id, forks: [] };
  return { parentPieceId: pending[0]!.id, forks: pending.slice(1) };
}

export function rememberActiveWorkPiece(sessionId: string, pieceId: string | undefined): void {
  if (pieceId) activeWorkPiece.set(sessionId, pieceId);
}

export function activeWorkPieceId(sessionId: string): string | undefined {
  return activeWorkPiece.get(sessionId);
}

export function clearActiveWorkPiece(sessionId: string): void {
  activeWorkPiece.delete(sessionId);
}

export function parseConcurrentForks(metadata: Record<string, unknown> | undefined): ConcurrentForkRef[] {
  const raw = metadata?.[CONCURRENT_FORKS_KEY];
  if (!Array.isArray(raw)) return [];
  const forks: ConcurrentForkRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.sourceMessageId !== 'string' || typeof row.childSessionId !== 'string') continue;
    const status = row.status === 'idle' || row.status === 'failed' || row.status === 'running' ? row.status : 'running';
    forks.push({ sourceMessageId: row.sourceMessageId, childSessionId: row.childSessionId, status });
  }
  return forks;
}

function pieceText(message: SessionMessage | undefined): string {
  if (!message) return '';
  return visibleTaskText(
    message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  );
}

function pieceHasAttachment(message: SessionMessage | undefined): boolean {
  if (!message) return false;
  return message.parts.some((part) => {
    if (part.type === 'image') return true;
    return part.type === 'text' && (part.contextSources?.length ?? 0) > 0;
  });
}

export function pendingBotWorkPieces(store: SqliteStateStore, sessionId: string): WorkPiece[] {
  const waiting = listPendingHumanWork(store, sessionId);
  // Nothing waiting means no piece and no fork: skip folding the whole transcript,
  // which runSession otherwise paid on every start of a canonical bot chat.
  if (waiting.length === 0) return [];
  const messages = new Map(store.foldMessages(sessionId).map((message) => [message.id, message]));
  const pieces: WorkPiece[] = [];
  const goalIntake = store.getDaemonControl<Record<string, string>>(`bot.goal-intake:${sessionId}`) ?? {};
  for (const pending of waiting) {
    if (goalIntake[pending.id] && !goalIntake[pending.id]!.startsWith('goal_')) continue;
    const message = messages.get(pending.id);
    const text = pieceText(message);
    const hasAttachment = pieceHasAttachment(message);
    if (!text && !hasAttachment) continue;
    pieces.push({ id: pending.id, text, ...(hasAttachment ? { hasAttachment: true } : {}) });
  }
  return pieces;
}

function isCanonicalBotChat(session: SessionRecord | undefined): session is SessionRecord {
  return session?.mode === 'chat' && session.metadata?.canonicalBotChat === true;
}

function latestAssistant(store: SqliteStateStore, sessionId: string): string {
  const messages = store.foldMessages(sessionId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = pieceText(message);
    if (text) return text;
  }
  return '';
}

function deliverNote(store: SqliteStateStore, sessionId: string, key: string, text: string): void {
  try {
    store.appendMessage(sessionId, 'system', [{ type: 'text', text }], { key });
  } catch {
    try {
      store.enqueueSteer(sessionId, text, { target: 'next-step', role: 'system', key });
    } catch {
      /* The parent turn owns the transcript; the child result stays on the child. */
    }
  }
}

function writeForks(store: SqliteStateStore, sessionId: string, forks: ConcurrentForkRef[]): void {
  const session = store.getSession(sessionId);
  if (!session) return;
  store.updateSession(sessionId, {
    metadata: { ...session.metadata, [CONCURRENT_FORKS_KEY]: forks }
  });
}

export function coordinatorNote(childSessionId: string, excerpt: string): string {
  return `${COORDINATOR_NOTE_PREFIX}这段并发工作已交给子代理 ${childSessionId}。你是协调者，不要亲自重做。\n任务摘录：${excerpt.slice(0, 240)}`;
}

export function coordinatorViewOf(session: SessionRecord, messages: SessionMessage[]): SessionMessage[] {
  const forks = parseConcurrentForks(session.metadata);
  if (forks.length === 0) return messages;
  const bySource = new Map(forks.map((fork) => [fork.sourceMessageId, fork]));
  return messages.map((message) => {
    const fork = bySource.get(message.id);
    if (!fork || message.role !== 'user') return message;
    return {
      ...message,
      parts: [{ type: 'text', text: coordinatorNote(fork.childSessionId, pieceText(message)) }]
    };
  });
}

export interface ConcurrentForkHost {
  store: SqliteStateStore;
  runSession(sessionId: string): Promise<unknown>;
  log: { warn(message: string, details?: unknown): void };
}

export function applyConcurrentBotForks(host: ConcurrentForkHost, sessionId: string, inFlight: boolean): string[] {
  const session = host.store.getSession(sessionId);
  if (!isCanonicalBotChat(session)) return [];
  const pending = pendingBotWorkPieces(host.store, sessionId);
  if (!inFlight) {
    const idlePlan = planConcurrentBotForks({ inFlight: false, pending });
    rememberActiveWorkPiece(sessionId, idlePlan.parentPieceId ?? pending[0]?.id);
  }
  const plan = planConcurrentBotForks({
    inFlight,
    activePieceId: activeWorkPieceId(sessionId),
    pending
  });
  const known = parseConcurrentForks(session.metadata);
  const knownSources = new Set(known.map((fork) => fork.sourceMessageId));
  const created: ConcurrentForkRef[] = [];
  for (const piece of plan.forks) {
    if (knownSources.has(piece.id)) continue;
    const child = spawnWorkChild(host, session, piece);
    created.push({ sourceMessageId: piece.id, childSessionId: child.id, status: 'running' });
    knownSources.add(piece.id);
    const childId = child.id;
    void Promise.resolve(host.runSession(childId)).then(
      () => {
        const summary = latestAssistant(host.store, childId) || '子代理没有留下文字结果。';
        deliverNote(host.store, sessionId, `bot-fork-result:${childId}`, `【子代理完成】${childId}\n${summary.slice(0, 4000)}`);
        finishFork(host.store, sessionId, childId, 'idle');
      },
      (error: unknown) => {
        deliverNote(host.store, sessionId, `bot-fork-result:${childId}`, `【子代理失败】${childId}\n${String(error).slice(0, 500)}`);
        finishFork(host.store, sessionId, childId, 'failed');
        host.log.warn('Concurrent bot sub-agent failed', { sessionId, childId, error: String(error) });
      }
    );
  }
  if (created.length > 0) writeForks(host.store, sessionId, [...known, ...created]);
  return created.map((fork) => fork.childSessionId);
}

function finishFork(
  store: SqliteStateStore,
  sessionId: string,
  childSessionId: string,
  status: ConcurrentForkRef['status']
): void {
  const session = store.getSession(sessionId);
  if (!session) return;
  const forks = parseConcurrentForks(session.metadata).map((fork) =>
    fork.childSessionId === childSessionId ? { ...fork, status } : fork
  );
  writeForks(store, sessionId, forks);
}

function spawnWorkChild(host: ConcurrentForkHost, parent: SessionRecord, piece: WorkPiece): SessionRecord {
  const botId = typeof parent.metadata?.botId === 'string' ? parent.metadata.botId : undefined;
  const permissionMode = childPermissionMode(parent.metadata);
  const goalId = host.store.getDaemonControl<Record<string,string>>(`bot.goal-intake:${parent.id}`)?.[piece.id];
  const child = host.store.createSession({
    title: `子任务: ${piece.text.slice(0, 40)}`,
    mode: 'subagent',
    agentId: parent.agentId,
    taskId: parent.taskId,
    parentSessionId: parent.id,
    background: true,
    metadata: {
      ...(goalId?.startsWith('goal_') ? { botGoalId: goalId, botGoalScopeSessionId: parent.id } : {}),
      parentSessionId: parent.id,
      spawnSource: 'concurrent-bot-work',
      sourceMessageId: piece.id,
      subagentRole: parent.agentId,
      ...(botId ? { botId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...inheritBotAllowlists(parent.metadata, {
        agentAllowedTools: host.store.getAgent(parent.agentId)?.allowedTools
      }),
      ...inheritModelOverride(parent.metadata),
      ...inheritBotIdentityMetadata(parent, host.store),
      ...inheritForkRetrievalMetadata(parent.metadata)
    }
  });
  const source = host.store.foldMessages(parent.id).find((message) => message.id === piece.id);
  host.store.appendMessage(
    child.id,
    'user',
    forkOpeningMessage({
      store: host.store,
      parentSessionId: parent.id,
      childSessionId: child.id,
      taskText: piece.text,
      triggerParts: source?.parts
    })
  );
  return child;
}
