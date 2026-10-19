/**
 * L1 session surface contract. SQLite {@link SessionStore} is the default
 * WAL implementation; {@link SqliteStateStore} adds inbox. Embedders may
 * supply {@link createMemorySurfaceStore}.
 *
 * Loop / turn kernel depend on this interface, not the concrete class.
 * Writer claim is optional: empty claim = legacy unrestricted append.
 */

import { createId, nowIso } from '../helpers.js';
import type { MessageReplyTo, MessageRole, SessionMessage, SessionRecord } from '../types.js';
import {
  assertReplaceRangeClosed,
  assertReplaceRangeCovered,
  assertSeqStrictlyIncreasing,
  foldSurface,
  type SurfaceNode,
  type SurfaceOp
} from './surface-invariants.js';
import { assertWriterClaim, WriterClaimError } from './writer-claim.js';
import type { EnqueueSteerOptions, InboxItem, InboxTarget } from './step-inbox.js';

export interface SurfaceWriteOpts {
  key?: string;
  expectedWriterRunId?: string;
  /** Quote pointer stored with this append. Callers pass the short excerpt, not the quoted body. */
  replyTo?: MessageReplyTo;
}

export interface SurfaceReplaceInput {
  startSeq: number;
  endSeq: number;
  role: MessageRole;
  parts: SessionMessage['parts'];
  key?: string;
  expectedWriterRunId?: string;
}

/** Phase 1 name; same shape plus optional writer claim. */
export type SurfaceReplacementInput = SurfaceReplaceInput;

/**
 * Session surface store: append / replace / hide / fold + inbox claim.
 * Implementations must keep WAL append-only; fold is the model packing view.
 */
export interface SessionSurfaceStore {
  getSession(id: string): SessionRecord | undefined;
  appendMessage(
    sessionId: string,
    role: MessageRole,
    parts: SessionMessage['parts'],
    opts?: SurfaceWriteOpts
  ): SessionMessage;
  appendReplacement(sessionId: string, input: SurfaceReplaceInput): SessionMessage;
  hideByKey(sessionId: string, key: string, opts?: { expectedWriterRunId?: string }): number;
  hideRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
    opts?: { expectedWriterRunId?: string }
  ): SessionMessage;
  foldMessages(sessionId: string): SessionMessage[];
  /** Audit WAL (includes shadowed content rows; not the model path). */
  listMessages(sessionId: string): SessionMessage[];
  listSurfaceNodes(sessionId: string): SurfaceNode[];
  enqueueSteer(sessionId: string, text: string, opts?: EnqueueSteerOptions): InboxItem;
  claimInbox(sessionId: string, target: InboxTarget): InboxItem[];
}

export interface SessionSurfaceStoreExt extends SessionSurfaceStore {
  listUnclaimedInbox(sessionId: string): InboxItem[];
  getUnclaimedInbox(sessionId: string, itemId: string): InboxItem | undefined;
  updateUnclaimedInbox(sessionId: string, itemId: string, text: string): InboxItem | undefined;
  removeUnclaimedInbox(sessionId: string, itemId: string): boolean;
  claimWriter(sessionId: string, runId: string): void;
  releaseWriter(sessionId: string, runId: string): void;
}

function nodeToMessage(node: SurfaceNode): SessionMessage {
  return {
    id: node.id,
    sessionId: node.sessionId,
    role: node.role,
    parts: node.parts,
    createdAt: node.createdAt,
    seq: node.seq,
    ...(node.key ? { key: node.key } : {}),
    ...(node.replyTo ? { replyTo: node.replyTo } : {})
  };
}

export class MemorySurfaceStore implements SessionSurfaceStoreExt {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly nodes = new Map<string, SurfaceNode[]>();
  private readonly inbox = new Map<string, InboxItem[]>();
  private readonly writerBindings = new Map<string, string>();

  createSession(input: {
    title: string;
    mode: SessionRecord['mode'];
    agentId: string;
    taskId?: string;
    workspaceId?: string;
    parentSessionId?: string;
    background?: boolean;
    metadata?: Record<string, unknown>;
  }): SessionRecord {
    const now = nowIso();
    const session: SessionRecord = {
      id: createId('session'),
      title: input.title,
      mode: input.mode,
      status: 'idle',
      agentId: input.agentId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      background: input.background ?? false,
      todo: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    this.nodes.set(session.id, []);
    this.inbox.set(session.id, []);
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s, metadata: { ...s.metadata } } : undefined;
  }

  updateSession(sessionId: string, patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new Error(`Session ${sessionId} not found`);
    const next: SessionRecord = { ...existing, ...patch, updatedAt: nowIso() };
    this.sessions.set(sessionId, next);
    return next;
  }

  claimWriter(sessionId: string, runId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new Error(`Session ${sessionId} not found`);
    if (existing.activeWriterRunId && existing.activeWriterRunId !== runId) {
      throw new WriterClaimError(sessionId, runId, existing.activeWriterRunId);
    }
    existing.activeWriterRunId = runId;
    existing.updatedAt = nowIso();
    this.writerBindings.set(sessionId, runId);
  }

  releaseWriter(sessionId: string, runId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing?.activeWriterRunId === runId) {
      existing.activeWriterRunId = undefined;
      existing.updatedAt = nowIso();
    }
    if (this.writerBindings.get(sessionId) === runId) {
      this.writerBindings.delete(sessionId);
    }
  }

  appendMessage(
    sessionId: string,
    role: MessageRole,
    parts: SessionMessage['parts'],
    opts?: SurfaceWriteOpts
  ): SessionMessage {
    return nodeToMessage(
      this.insertNode({
        sessionId,
        role,
        parts,
        surfaceOp: 'append',
        key: opts?.key,
        expectedWriterRunId: opts?.expectedWriterRunId,
        replyTo: opts?.replyTo
      })
    );
  }

  /** Alias matching the plan's `append` name. */
  append(
    sessionId: string,
    role: MessageRole,
    parts: SessionMessage['parts'],
    opts?: SurfaceWriteOpts
  ): SessionMessage {
    return this.appendMessage(sessionId, role, parts, opts);
  }

  appendReplacement(sessionId: string, input: SurfaceReplaceInput): SessionMessage {
    const wal = this.listSurfaceNodes(sessionId);
    assertSeqStrictlyIncreasing(wal);
    assertReplaceRangeCovered(wal, input.startSeq, input.endSeq);
    assertReplaceRangeClosed(wal, input.startSeq, input.endSeq);
    return nodeToMessage(
      this.insertNode({
        sessionId,
        role: input.role,
        parts: input.parts,
        surfaceOp: 'replace',
        key: input.key,
        replacesStart: input.startSeq,
        replacesEnd: input.endSeq,
        expectedWriterRunId: input.expectedWriterRunId
      })
    );
  }

  hideByKey(sessionId: string, key: string, opts?: { expectedWriterRunId?: string }): number {
    if (!key) return 0;
    const folded = this.foldMessages(sessionId);
    const targets = folded.filter((m) => m.key === key && m.seq !== undefined);
    for (const message of targets) {
      this.insertNode({
        sessionId,
        role: message.role,
        parts: [],
        surfaceOp: 'hide',
        key,
        replacesStart: message.seq,
        replacesEnd: message.seq,
        expectedWriterRunId: opts?.expectedWriterRunId
      });
    }
    return targets.length;
  }

  hideRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
    opts?: { expectedWriterRunId?: string }
  ): SessionMessage {
    const wal = this.listSurfaceNodes(sessionId);
    assertSeqStrictlyIncreasing(wal);
    assertReplaceRangeCovered(wal, startSeq, endSeq);
    return nodeToMessage(
      this.insertNode({
        sessionId,
        role: 'system',
        parts: [],
        surfaceOp: 'hide',
        replacesStart: startSeq,
        replacesEnd: endSeq,
        expectedWriterRunId: opts?.expectedWriterRunId
      })
    );
  }

  foldMessages(sessionId: string): SessionMessage[] {
    return foldSurface(this.listSurfaceNodes(sessionId));
  }

  listMessages(sessionId: string): SessionMessage[] {
    return this.listSurfaceNodes(sessionId)
      .filter((n) => n.surfaceOp !== 'hide')
      .map(nodeToMessage);
  }

  listSurfaceNodes(sessionId: string): SurfaceNode[] {
    const list = this.nodes.get(sessionId) ?? [];
    assertSeqStrictlyIncreasing(list);
    return list.map((n) => ({ ...n, parts: [...n.parts] }));
  }

  enqueueSteer(sessionId: string, text: string, opts: EnqueueSteerOptions = {}): InboxItem {
    const item: InboxItem = {
      id: createId('steer'),
      sessionId,
      target: opts.target ?? 'next-step',
      role: opts.role ?? 'user',
      text,
      contextParts: opts.contextParts,
      replyTo: opts.replyTo,
      key: opts.key,
      createdAt: nowIso()
    };
    const list = this.inbox.get(sessionId) ?? [];
    list.push(item);
    this.inbox.set(sessionId, list);
    return item;
  }

  claimInbox(sessionId: string, target: InboxTarget): InboxItem[] {
    const list = this.inbox.get(sessionId) ?? [];
    const unclaimed = list.filter((i) => !i.claimedAt && i.target === target);
    const latestByKey = new Map<string, InboxItem>();
    const keyedSkipped: InboxItem[] = [];
    const unkeyed: InboxItem[] = [];
    for (const item of unclaimed) {
      if (!item.key) {
        unkeyed.push(item);
        continue;
      }
      const prev = latestByKey.get(item.key);
      if (prev) keyedSkipped.push(prev);
      latestByKey.set(item.key, item);
    }
    const claimedAt = nowIso();
    const apply = [...unkeyed, ...latestByKey.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
    for (const item of [...apply, ...keyedSkipped]) {
      item.claimedAt = claimedAt;
    }
    return apply;
  }

  listUnclaimedInbox(sessionId: string): InboxItem[] {
    return (this.inbox.get(sessionId) ?? []).filter((i) => !i.claimedAt);
  }

  getUnclaimedInbox(sessionId: string, itemId: string): InboxItem | undefined {
    return this.listUnclaimedInbox(sessionId).find((i) => i.id === itemId);
  }

  updateUnclaimedInbox(sessionId: string, itemId: string, text: string): InboxItem | undefined {
    const next = text.trim();
    if (!next) return undefined;
    const item = this.getUnclaimedInbox(sessionId, itemId);
    if (!item) return undefined;
    item.text = next;
    return item;
  }

  removeUnclaimedInbox(sessionId: string, itemId: string): boolean {
    const list = this.inbox.get(sessionId) ?? [];
    const idx = list.findIndex((i) => i.id === itemId && !i.claimedAt);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.inbox.set(sessionId, list);
    return true;
  }

  copyWalPrefix(fromId: string, toId: string, endSeq: number): number {
    const src = this.nodes.get(fromId) ?? [];
    const prefix = src.filter((n) => n.seq <= endSeq).map((n) => ({
      ...n,
      id: createId('msg'),
      sessionId: toId,
      parts: [...n.parts]
    }));
    this.nodes.set(toId, prefix);
    return prefix.length;
  }

  private insertNode(input: {
    sessionId: string;
    role: MessageRole;
    parts: SessionMessage['parts'];
    surfaceOp: SurfaceOp;
    key?: string;
    replacesStart?: number;
    replacesEnd?: number;
    expectedWriterRunId?: string;
    replyTo?: MessageReplyTo;
  }): SurfaceNode {
    const session = this.sessions.get(input.sessionId);
    assertWriterClaim({
      sessionId: input.sessionId,
      activeWriterRunId: session?.activeWriterRunId,
      expectedWriterRunId: input.expectedWriterRunId,
      boundWriterRunId: this.writerBindings.get(input.sessionId)
    });
    const list = this.nodes.get(input.sessionId) ?? [];
    const seq = (list[list.length - 1]?.seq ?? 0) + 1;
    const node: SurfaceNode = {
      id: createId('msg'),
      sessionId: input.sessionId,
      seq,
      key: input.key,
      surfaceOp: input.surfaceOp,
      replacesStart: input.replacesStart,
      replacesEnd: input.replacesEnd,
      role: input.role,
      parts: input.parts,
      createdAt: nowIso(),
      ...(input.replyTo ? { replyTo: input.replyTo } : {})
    };
    list.push(node);
    this.nodes.set(input.sessionId, list);
    if (session) session.updatedAt = node.createdAt;
    return node;
  }
}

export function createMemorySurfaceStore(): MemorySurfaceStore {
  return new MemorySurfaceStore();
}
