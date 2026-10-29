import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type OutboundDraftStatus =
  | 'pending_approval'
  | 'confirmed'
  | 'sending'
  | 'sent'
  | 'rejected'
  | 'failed';

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
  /** Bumped on every human edit. Absent means never edited (0). */
  revision?: number;
  /** Text as first drafted. Set on the first edit only. */
  originalText?: string;
  editedAt?: string;
}

export type OutboundDraftErrorCode =
  | 'not_found'
  | 'not_pending'
  | 'not_confirmed'
  | 'not_editable'
  | 'empty_text'
  | 'text_too_long'
  | 'stale_revision';

/** Upper bound for a human-edited preview. Larger than any channel's own limit. */
export const OUTBOUND_DRAFT_MAX_TEXT = 20_000;

export class OutboundDraftError extends Error {
  readonly code: OutboundDraftErrorCode;
  readonly draftId: string;

  constructor(code: OutboundDraftErrorCode, draftId: string, message: string) {
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


export function draftRevision(draft: Pick<OutboundDraft, 'revision'>): number {
  return draft.revision ?? 0;
}

/**
 * Reject a confirm/send that was issued against an older preview than the stored text.
 * `undefined` skips the check (legacy callers); the UI always passes the revision it showed.
 */
export function assertDraftRevision(draft: OutboundDraft, expected: number | undefined): void {
  if (expected === undefined || expected === draftRevision(draft)) return;
  throw new OutboundDraftError('stale_revision', draft.id, `draft ${draft.id} changed since it was previewed`);
}

function assertEditableText(id: string, text: string): void {
  if (!text.trim()) throw new OutboundDraftError('empty_text', id, 'draft text must not be empty');
  if (text.length > OUTBOUND_DRAFT_MAX_TEXT) {
    throw new OutboundDraftError('text_too_long', id, `draft text exceeds ${OUTBOUND_DRAFT_MAX_TEXT} characters`);
  }
}

/**
 * Human edit of the preview text. Only `pending_approval` / `failed` drafts are editable;
 * a confirmed or sending draft is already being released. Does not confirm and does not POST.
 */
export async function editOutboundDraft(
  gatewayDir: string,
  id: string,
  input: { text: string; expectedRevision?: number }
): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    if (draft.status !== 'pending_approval' && draft.status !== 'failed') {
      throw new OutboundDraftError('not_editable', id, `draft ${id} is ${draft.status}`);
    }
    assertDraftRevision(draft, input.expectedRevision);
    assertEditableText(id, input.text);
    if (input.text === draft.text) return { ...draft };
    draft.originalText ??= draft.text;
    draft.text = input.text;
    draft.revision = draftRevision(draft) + 1;
    draft.editedAt = new Date().toISOString();
    draft.error = undefined;
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}

/**
 * Human confirm step. Moves `pending_approval` (or retryable `failed`) → `confirmed`.
 * Does not POST. Call `claimOutboundDraft` + transport (or `sendConfirmedOutboundDraft`) to send.
 */
export async function confirmOutboundDraft(
  gatewayDir: string,
  id: string,
  opts: { expectedRevision?: number } = {}
): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    if (draft.status !== 'pending_approval' && draft.status !== 'failed') {
      throw new OutboundDraftError('not_pending', id, `draft ${id} is ${draft.status}`);
    }
    assertDraftRevision(draft, opts.expectedRevision);
    draft.status = 'confirmed';
    draft.decidedAt = new Date().toISOString();
    draft.error = undefined;
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}

/** Move a confirmed (or legacy pending/failed) draft to `sending`. Concurrent callers lose the race. */
export async function claimOutboundDraft(gatewayDir: string, id: string): Promise<OutboundDraft> {
  return withGatewayLock(gatewayDir, async () => {
    const items = await readOutboundDrafts(gatewayDir);
    const draft = items.find((item) => item.id === id);
    if (!draft) throw new OutboundDraftError('not_found', id, `draft ${id} not found`);
    if (draft.status !== 'confirmed' && draft.status !== 'pending_approval' && draft.status !== 'failed') {
      throw new OutboundDraftError('not_confirmed', id, `draft ${id} is ${draft.status}`);
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
    if (
      draft.status !== 'pending_approval' &&
      draft.status !== 'confirmed' &&
      draft.status !== 'failed'
    ) {
      throw new OutboundDraftError('not_pending', id, `draft ${id} is ${draft.status}`);
    }
    draft.status = 'rejected';
    draft.decidedAt = new Date().toISOString();
    await writeDrafts(gatewayDir, items);
    return { ...draft };
  });
}
