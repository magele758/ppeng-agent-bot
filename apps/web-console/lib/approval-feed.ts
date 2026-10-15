/** Where a pending approval sits in the visible chat feed. */

export type ApprovalFeedItem = {
  id: string;
  toolName: string;
  reason?: string;
  args?: Record<string, unknown>;
};

export type FeedPartLike = {
  type?: string;
  name?: string;
  toolCallId?: string;
  input?: unknown;
};

export type FeedMessageLike = {
  parts?: readonly FeedPartLike[];
};

export type StreamToolLike = {
  name: string;
  toolCallId?: string;
  args?: string;
};

export type ApprovalAnchors<T> = {
  afterMessage: Map<number, T[]>;
  afterStream: T[];
  trailing: T[];
};

type Site = {
  bucket: 'message' | 'stream';
  mi: number;
  name: string;
  input: unknown;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(rec[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function callInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const text = value.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function sameArgs(call: unknown, args: unknown): boolean {
  return stable(call ?? {}) === stable(args ?? {});
}

/**
 * Pair each pending approval with the waiting tool call it belongs to.
 * Resolved calls are skipped. A later equal match wins, so a live stream
 * call sits closer than an earlier copy of the same call.
 */
export function anchorApprovals<T extends ApprovalFeedItem>(
  messages: readonly FeedMessageLike[],
  approvals: readonly T[],
  resolvedCallIds: ReadonlySet<string>,
  streamTools: readonly StreamToolLike[] = []
): ApprovalAnchors<T> {
  const sites: Site[] = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    for (const part of messages[mi]?.parts ?? []) {
      if (part.type !== 'tool_call') continue;
      if (part.toolCallId && resolvedCallIds.has(part.toolCallId)) continue;
      sites.push({
        bucket: 'message',
        mi,
        name: part.name ?? '',
        input: part.input ?? {}
      });
    }
  }
  for (const tool of streamTools) {
    if (tool.toolCallId && resolvedCallIds.has(tool.toolCallId)) continue;
    sites.push({
      bucket: 'stream',
      mi: -1,
      name: tool.name,
      input: callInput(tool.args)
    });
  }

  const used = new Set<number>();
  const afterMessage = new Map<number, T[]>();
  const afterStream: T[] = [];
  const trailing: T[] = [];

  for (const approval of approvals) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < sites.length; i += 1) {
      if (used.has(i)) continue;
      const site = sites[i]!;
      if (site.name !== approval.toolName) continue;
      const score = sameArgs(site.input, approval.args) ? 2 : 1;
      if (score >= bestScore) {
        best = i;
        bestScore = score;
      }
    }
    if (best < 0) {
      trailing.push(approval);
      continue;
    }
    used.add(best);
    const site = sites[best]!;
    if (site.bucket === 'stream') {
      afterStream.push(approval);
      continue;
    }
    const list = afterMessage.get(site.mi) ?? [];
    list.push(approval);
    afterMessage.set(site.mi, list);
  }

  return { afterMessage, afterStream, trailing };
}

/** Lines the approval block shows. The same reason string is not repeated as the question. */
export function approvalShownLines(
  approval: { toolName: string; reason?: string; args?: Record<string, unknown> },
  needInfo: string
): { reason: string | null; question: string | null; reply: boolean } {
  const reply = approval.toolName === 'ask_user';
  const reason = approval.reason?.trim() ? approval.reason.trim() : null;
  const questionRaw = typeof approval.args?.question === 'string' ? approval.args.question.trim() : '';
  let question: string | null = null;
  if (reply) {
    if (questionRaw && questionRaw !== reason) question = questionRaw;
    else if (!reason) question = needInfo;
  }
  return { reason, question, reply };
}
