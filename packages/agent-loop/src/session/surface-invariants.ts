/**
 * Session surface algebra: WAL stays append-only; fold() is the only packing
 * entry that produces the SessionMessage[] sent to the model.
 *
 *   WAL append  ──►  surface nodes (seq / key / visible)
 *                       │
 *                       ▼
 *                 fold(surface) = SessionMessage[]
 */

import type { MessagePart, MessageReplyTo, MessageRole, SessionMessage } from '../types.js';

export type SurfaceOp = 'append' | 'replace' | 'hide';

export interface SurfaceNode {
  id: string;
  sessionId: string;
  seq: number;
  key?: string;
  surfaceOp: SurfaceOp;
  replacesStart?: number;
  replacesEnd?: number;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: string;
  /** Quote pointer copied onto the visible message. Not the quoted body. */
  replyTo?: MessageReplyTo;
}

export class SurfaceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceInvariantError';
  }
}

export function parseSurfaceOp(raw: unknown): SurfaceOp {
  if (raw === 'replace' || raw === 'hide' || raw === 'append') return raw;
  return 'append';
}

export function assertSeqStrictlyIncreasing(nodes: SurfaceNode[]): void {
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1]!.seq;
    const cur = nodes[i]!.seq;
    if (!(cur > prev)) {
      throw new SurfaceInvariantError(
        `surface seq must be strictly increasing (seq ${prev} then ${cur})`
      );
    }
  }
}

export function assertReplaceRangeCovered(
  nodes: SurfaceNode[],
  startSeq: number,
  endSeq: number
): void {
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || startSeq > endSeq) {
    throw new SurfaceInvariantError(
      `replace range must be integers with startSeq <= endSeq (got ${startSeq}..${endSeq})`
    );
  }
  const seqs = new Set(nodes.map((n) => n.seq));
  for (let s = startSeq; s <= endSeq; s++) {
    if (!seqs.has(s)) {
      throw new SurfaceInvariantError(
        `replace range [${startSeq}, ${endSeq}] is dangling: seq ${s} was never appended`
      );
    }
  }
}

export function unmatchedToolCallIds(messages: Array<{ parts: MessagePart[] }>): string[] {
  const open = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') open.add(part.toolCallId);
      else if (part.type === 'tool_result') open.delete(part.toolCallId);
    }
  }
  return [...open];
}

export function isToolWaveOpen(messages: Array<{ parts: MessagePart[] }>): boolean {
  return unmatchedToolCallIds(messages).length > 0;
}

/**
 * A replace may only cover a closed turn: every assistant tool_call in the
 * range must have a matching tool_result in the same range, and the range
 * must not cut a later-resolved tool wave in half.
 */
export function assertReplaceRangeClosed(
  nodes: SurfaceNode[],
  startSeq: number,
  endSeq: number
): void {
  const folded = foldSurface(nodes);
  const inRange = folded.filter(
    (m) => m.seq !== undefined && m.seq >= startSeq && m.seq <= endSeq
  );
  const afterRange = folded.filter((m) => m.seq !== undefined && m.seq > endSeq);

  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of inRange) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') calls.add(part.toolCallId);
      else if (part.type === 'tool_result') results.add(part.toolCallId);
    }
  }
  const unresolved = [...calls].filter((id) => !results.has(id));
  if (unresolved.length === 0) return;

  const laterResults = new Set<string>();
  for (const message of afterRange) {
    for (const part of message.parts) {
      if (part.type === 'tool_result') laterResults.add(part.toolCallId);
    }
  }
  if (unresolved.some((id) => laterResults.has(id))) {
    throw new SurfaceInvariantError(
      `replace [${startSeq}, ${endSeq}] would split an open tool wave (${unresolved.join(', ')})`
    );
  }
  throw new SurfaceInvariantError(
    `cannot replace an open tool wave [${startSeq}, ${endSeq}]: unmatched tool_call ${unresolved.join(', ')}`
  );
}

export function assertNoOpenToolWaveForCompact(folded: SessionMessage[]): void {
  const open = unmatchedToolCallIds(folded);
  if (open.length > 0) {
    throw new SurfaceInvariantError(
      `cannot compact while a tool wave is open (unmatched tool_call: ${open.join(', ')})`
    );
  }
}

/** Hide / replace ops shadow the inclusive seq range they name. */
export function shadowedSeqs(nodes: SurfaceNode[]): Set<number> {
  const hidden = new Set<number>();
  // compact-summary is a rolling snapshot. A successful newer replacement
  // retires its predecessor even when the replaced range does not contain it.
  // Keep this in the fold algebra so SQLite and embedded stores agree, and
  // hiding the newest summary never resurrects an obsolete one.
  let latestSummarySeq = -1;
  for (const node of nodes) {
    if (node.surfaceOp === 'replace' && node.key === 'compact-summary') {
      latestSummarySeq = Math.max(latestSummarySeq, node.seq);
    }
  }
  for (const node of nodes) {
    if (node.surfaceOp === 'replace' && node.key === 'compact-summary' && node.seq !== latestSummarySeq) {
      hidden.add(node.seq);
    }
    if (node.surfaceOp === 'replace' || node.surfaceOp === 'hide') {
      if (
        typeof node.replacesStart === 'number' &&
        typeof node.replacesEnd === 'number' &&
        Number.isInteger(node.replacesStart) &&
        Number.isInteger(node.replacesEnd)
      ) {
        for (let s = node.replacesStart; s <= node.replacesEnd; s++) {
          hidden.add(s);
        }
      }
    }
    if (node.surfaceOp === 'hide') {
      hidden.add(node.seq);
    }
  }
  return hidden;
}

/**
 * Deterministic fold: later hide/replace ops shadow earlier seqs. Hide rows
 * themselves never appear in the model view.
 */
export function foldSurface(nodes: SurfaceNode[]): SessionMessage[] {
  const ordered = [...nodes].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const hidden = shadowedSeqs(ordered);
  const out: SessionMessage[] = [];
  for (const node of ordered) {
    if (node.surfaceOp === 'hide') continue;
    if (hidden.has(node.seq)) continue;
    out.push(surfaceNodeToMessage(node));
  }
  return out;
}

export function surfaceNodeToMessage(node: SurfaceNode): SessionMessage {
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

/** Canonical JSON for fold-determinism checks (byte-stable key order). */
export function foldCanonicalJson(messages: SessionMessage[]): string {
  return JSON.stringify(messages);
}
