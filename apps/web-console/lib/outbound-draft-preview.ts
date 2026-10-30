import type { MessageKey } from './i18n/messages/types.ts';

export type OutboundIdentityKind =
  | 'webhook'
  | 'http_post'
  | 'feishu_bot'
  | 'wecom_group_bot'
  | 'slack'
  | 'telegram'
  | 'email'
  | 'feishu_app'
  | 'unknown';

/** Who a draft will send as. `sender` is a non-secret handle (masked id, env var name, host). */
export interface OutboundIdentity {
  channelId: string;
  kind: OutboundIdentityKind;
  resolved: boolean;
  sender?: string;
  recipient?: string;
}

export interface DraftPreviewBase {
  id: string;
  text: string;
  status: string;
  revision?: number;
}

/** Mirrors the gateway limit; the daemon enforces it. */
export const OUTBOUND_DRAFT_MAX_TEXT = 20_000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function identityKindKey(kind: OutboundIdentityKind): MessageKey {
  return `tasks.inbox.identityKind.${kind}`;
}

export function isDraftEditable(status: string): boolean {
  return status === 'pending_approval' || status === 'failed';
}

export function draftRevisionOf(draft: Pick<DraftPreviewBase, 'revision'>): number {
  return draft.revision ?? 0;
}

export function canSaveDraftText(draft: Pick<DraftPreviewBase, 'text'>, value: string): boolean {
  return value.trim().length > 0 && value.length <= OUTBOUND_DRAFT_MAX_TEXT && value !== draft.text;
}

/**
 * Approve stays unavailable while the editor is open: the human must save or discard first,
 * so the text they approve is always the text they last saw.
 */
export function canApproveDraft(editing: boolean): boolean {
  return !editing;
}

/** The URL verb decides; the body only pins the preview revision the human saw. */
export function approveInit(draft: DraftPreviewBase): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ revision: draftRevisionOf(draft) }) };
}

export function editInit(draft: DraftPreviewBase, text: string): RequestInit {
  return { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ text, revision: draftRevisionOf(draft) }) };
}

/** How many same-channel messages a glance shows. Advisory only — never fed back into the draft. */
export const STYLE_SAMPLE_LIMIT = 3;

export interface StyleSample {
  text: string;
}

/**
 * Option A: before approve, suggest glancing at recent messages in this channel.
 * The hint never blocks send and never rewrites the draft the human already wrote.
 */
export function shouldSuggestStyleSample(status: string): boolean {
  return status === 'pending_approval' || status === 'failed';
}

/**
 * A request for recent same-channel messages the human can glance at.
 * Callers must not write the result into draft text (no summaries, no style prompt).
 */
export function styleSampleRequest(channelId: string): { channelId: string; limit: number } {
  return { channelId, limit: STYLE_SAMPLE_LIMIT };
}

/** Samples are a side glance. The body the human wrote is returned unchanged. */
export function draftTextAfterSamples(text: string, _samples: readonly StyleSample[]): string {
  return text;
}

/** Daemon answers 403 `human_login_required` when Lab login is off; the panel asks the operator to turn it on. */
export function draftActionError(error: unknown): { loginRequired: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { loginRequired: message === 'human_login_required', message };
}
