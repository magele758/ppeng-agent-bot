/**
 * Pure store helper: apply claimed step-inbox items (Port B).
 *
 * For each item: hide the previous same-key node (if any), then append
 * role+text. `claimAndApplyInbox` no-ops when the host has no inbox.
 */

import type { TextPart } from '@ppeng/api-types';
import type { MessagePart, MessageReplyTo, MessageRole, SessionMessage } from '../types.js';
import type { InboxTarget } from './step-inbox.js';

export interface ClaimedInboxItem {
  key?: string;
  role: 'user' | 'system';
  text: string;
  contextParts?: TextPart[];
  replyTo?: MessageReplyTo;
}

export interface ApplyClaimedInboxOpts {
  expectedWriterRunId?: string;
}

export interface ApplyClaimedInboxStore {
  hideByKey?(sessionId: string, key: string, opts?: { expectedWriterRunId?: string }): number;
  appendMessage(
    sessionId: string,
    role: MessageRole,
    parts: MessagePart[],
    opts?: { key?: string; expectedWriterRunId?: string; replyTo?: MessageReplyTo }
  ): SessionMessage;
  claimInbox?(sessionId: string, target: InboxTarget): ClaimedInboxItem[];
}

function textPart(text: string): MessagePart {
  return { type: 'text', text };
}

export function applyClaimedInbox(
  store: ApplyClaimedInboxStore,
  sessionId: string,
  items: ClaimedInboxItem[],
  opts?: ApplyClaimedInboxOpts
): void {
  for (const item of items) {
    if (item.key) {
      store.hideByKey?.(sessionId, item.key, opts);
    }
    store.appendMessage(
      sessionId,
      item.role,
      [textPart(item.text), ...(item.contextParts ?? [])],
      item.key
        ? { key: item.key, expectedWriterRunId: opts?.expectedWriterRunId, ...(item.replyTo ? {replyTo:item.replyTo} : {}) }
        : { expectedWriterRunId: opts?.expectedWriterRunId, ...(item.replyTo ? {replyTo:item.replyTo} : {}) }
    );
  }
}

export function claimAndApplyInbox(
  store: ApplyClaimedInboxStore,
  sessionId: string,
  target: InboxTarget,
  opts?: ApplyClaimedInboxOpts
): ClaimedInboxItem[] {
  if (!store.claimInbox) return [];
  const items = store.claimInbox(sessionId, target);
  applyClaimedInbox(store, sessionId, items, opts);
  return items;
}
