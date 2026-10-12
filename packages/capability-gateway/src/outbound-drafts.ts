import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type OutboundDraftStatus = 'pending_approval' | 'sending' | 'sent' | 'rejected' | 'failed';

export type FeishuReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'chat_id';

export interface OutboundDraft {
  id: string;
  channelId: string;
  text: string;
  event?: string;
  createdAt: string;
  status: OutboundDraftStatus;
  /** Feishu recipient from the inbound event. Channel defaults are not a substitute. */
  receiveId?: string;
  receiveIdType?: FeishuReceiveIdType;
  decidedAt?: string;
  error?: string;
}

export class OutboundDraftError extends Error {
  readonly code: 'not_found' | 'not_pending';
  readonly draftId: string;

  constructor(code: 'not_found' | 'not_pending', draftId: string, message: string) {
    super(message);
    this.name = 'OutboundDraftError';
    this.code = code;
    this.draftId = draftId;
  }
}

const tails = new Map<string, Promise<unknown>>();

function withGatewayLock<T>(gatewayDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(gatewayDir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    gatewayDir,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function draftsPath(gatewayDir: string): string {
  return join(gatewayDir, 'outbound-drafts.json');
}

export async function readOutboundDrafts(gatewayDir: string): Promise<OutboundDraft[]> {
  try {
    const raw = await readFile(draftsPath(gatewayDir), 'utf8');
    const parsed = JSON.parse(raw) as { items?: OutboundDraft[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function writeDrafts(gatewayDir: string, items: OutboundDraft[]): Promise<void> {
  await mkdir(gatewayDir, { recursive: true });
  const path = draftsPath(gatewayDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ items }, null, 2));
  await rename(tmp, path);
}

const RECEIVE_TYPES = new Set<FeishuReceiveIdType>(['open_id', 'user_id', 'union_id', 'chat_id']);

/** Hold proactive outbound until a human approves a real send. Does not POST. */
export async function appendOutboundDraft(
  gatewayDir: string,
  input: {
    channelId: string;
    text: string;
    event?: string;
    receiveId?: string;
    receiveIdType?: FeishuReceiveIdType;
  }
): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const receiveId = input.receiveId?.trim();
    const receiveIdType =
      input.receiveIdType && RECEIVE_TYPES.has(input.receiveIdType) ? input.receiveIdType : undefined;
    const draft: OutboundDraft = {
      id: `draft_${randomUUID().replace(/-/g, '')}`,
      channelId: input.channelId,
      text: input.text,
      event: input.event,
      createdAt: new Date().toISOString(),
      status: 'pending_approval',
      ...(receiveId && receiveIdType ? { receiveId, receiveIdType } : {})
    };
    items.push(draft);
    await writeDrafts(gatewayDir, items);
    return draft;
  });
}

/** Move a pending or failed draft to `sending`. Concurrent callers lose the race. */
export async function claimOutboundDraft(gatewayDir: string, id: string): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    if (draft.status !== 'pending_approval' && draft.status !== 'failed') {
      throw new OutboundDraftError('not_pending', id, `draft ${id} is ${draft.status}`);
    }
    draft.status = 'sending';
    draft.error = undefined;
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}

export async function settleOutboundDraft(
  gatewayDir: string,
  id: string,
  patch: { status: 'sent' | 'failed' | 'rejected'; error?: string }
): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    draft.status = patch.status;
    draft.decidedAt = new Date().toISOString();
    draft.error = patch.error;
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}

export async function rejectOutboundDraft(gatewayDir: string, id: string): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    if (draft.status !== 'pending_approval' && draft.status !== 'failed') {
      throw new OutboundDraftError('not_pending', id, `draft ${id} is ${draft.status}`);
    }
    draft.status = 'rejected';
    draft.decidedAt = new Date().toISOString();
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}
