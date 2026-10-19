/**
 * Session fork: new session copies a closed WAL prefix.
 * Open turn / open tool wave → 409 (do not silently trim).
 */

import { sharedExposureKey, sharedExposureState, type SharedExposureLookup } from '../bots/shared-context-isolation.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { readSessionModelOverride } from '../model/provider-catalog.js';
import { isToolWaveOpen } from './surface-invariants.js';
import { latestCheckpoint, lastClosedSeq } from './checkpoint.js';
import type { SurfaceNode } from './surface-invariants.js';
import type { SessionMessage, SessionRecord } from '../types.js';

export interface ForkCreateSessionInput {
  title: string;
  mode: SessionRecord['mode'];
  agentId: string;
  taskId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  background?: boolean;
  metadata?: Record<string, unknown>;
}

export type SessionForkReject = 'turn_open' | 'wave_open' | 'empty' | 'not_found';

export interface SessionForkStore extends SharedExposureLookup {
  getSession(id: string): SessionRecord | undefined;
  createSession(input: ForkCreateSessionInput): SessionRecord;
  updateSession(
    id: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>
  ): SessionRecord;
  foldMessages(sessionId: string): SessionMessage[];
  listSurfaceNodes(sessionId: string): SurfaceNode[];
  copyWalPrefix(fromId: string, toId: string, endSeq: number): number;
}

export interface ForkSessionInput {
  sourceSessionId: string;
  boundarySeq?: number;
  title?: string;
}

export interface ForkSessionResult {
  session: SessionRecord;
  seedSeq: number;
  copied: number;
}

export function assertCanFork(input: {
  session?: SessionRecord | null;
  folded: SessionMessage[];
}): SessionForkReject | undefined {
  if (!input.session) return 'not_found';
  if (input.session.status === 'running') return 'turn_open';
  if (isToolWaveOpen(input.folded)) return 'wave_open';
  return undefined;
}

export function forkRejectToError(code: SessionForkReject, sessionId: string): Error {
  switch (code) {
    case 'not_found':
      return new NotFoundError('Session', sessionId);
    case 'turn_open':
      return new ConflictError(`Session ${sessionId} has an open turn; fork is refused`);
    case 'wave_open':
      return new ConflictError(`Session ${sessionId} has an open tool wave; fork is refused`);
    case 'empty':
      return new ConflictError(`Session ${sessionId} has no closed prefix to fork`);
    default: {
      const _never: never = code;
      return _never;
    }
  }
}

export function resolveForkEndSeq(input: {
  session: SessionRecord;
  nodes: SurfaceNode[];
  folded: SessionMessage[];
  requestedSeq?: number;
}): { ok: true; endSeq: number } | { ok: false; reason: SessionForkReject } {
  if (input.nodes.length === 0) return { ok: false, reason: 'empty' };
  const closed = lastClosedSeq(input.nodes, input.folded);
  if (closed == null) return { ok: false, reason: 'wave_open' };
  const ckpt = latestCheckpoint(input.session.metadata);
  const defaultSeq = ckpt?.seq ?? closed;
  const endSeq = input.requestedSeq ?? defaultSeq;
  if (endSeq < 1 || endSeq > closed) {
    return { ok: false, reason: 'wave_open' };
  }
  return { ok: true, endSeq };
}

export function forkSession(store: SessionForkStore, input: ForkSessionInput): ForkSessionResult {
  const source = store.getSession(input.sourceSessionId);
  const folded = source ? store.foldMessages(input.sourceSessionId) : [];
  const reject = assertCanFork({ session: source, folded });
  if (reject) throw forkRejectToError(reject, input.sourceSessionId);
  const session = source!;
  const nodes = store.listSurfaceNodes(session.id);
  const boundary = resolveForkEndSeq({
    session,
    nodes,
    folded,
    requestedSeq: input.boundarySeq
  });
  if (!boundary.ok) throw forkRejectToError(boundary.reason, session.id);

  // A fork copies history, not membership in the parent's sharing domain.
  // Freeze inherited/pending exposure at the copied boundary so fresh private
  // child messages stay usable without reviving any withdrawn shared source.
  const exposure = sharedExposureState(store, session.id);
  const closedAt = new Date().toISOString();
  const inherited = [
    ...exposure.revoked,
    ...(exposure.active ? [{ fromSeq: exposure.active.fromSeq, toSeq: boundary.endSeq,
      startedAt: exposure.active.startedAt, endedAt: closedAt }] : [])
  ].map(range => ({ ...range, toSeq: Math.min(range.pending ? boundary.endSeq : range.toSeq, boundary.endSeq), pending: false }))
    .filter(range => range.fromSeq <= range.toSeq);
  if (inherited.length && !store.setDaemonControl) {
    throw new ConflictError('Cannot preserve shared-context restrictions in this fork');
  }

  const pinned = readSessionModelOverride(session.metadata);
  const child = store.createSession({
    title: input.title?.trim() || `Fork of ${session.title}`.slice(0, 80),
    mode: session.mode,
    agentId: session.agentId,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    parentSessionId: session.id,
    background: false,
    metadata: {
      forkedFrom: session.id,
      seedSeq: boundary.endSeq,
      ...(pinned ? { modelOverride: pinned } : {})
    }
  });
  if (inherited.length) store.setDaemonControl!(sharedExposureKey(child.id), { revoked: inherited });
  const copied = store.copyWalPrefix(session.id, child.id, boundary.endSeq);
  const next = store.updateSession(child.id, {
    metadata: {
      ...(child.metadata ?? {}),
      forkedFrom: session.id,
      seedSeq: boundary.endSeq,
      seedLength: copied
    }
  });
  return { session: next, seedSeq: boundary.endSeq, copied };
}
