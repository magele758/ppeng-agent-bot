import type { ChannelSpec } from './types.js';
import {
  appendOutboundDraft,
  editOutboundDraft,
  readOutboundDrafts,
  type FeishuReceiveIdType,
  type OutboundDraft
} from './outbound-drafts.js';
import { deferOutboundDraftForQuietHours, releaseOutboundDraft } from './outbound.js';
import { previewOutboundDraft, type OutboundDraftPreview } from './outbound-identity.js';
import { isQuietNow, quietWindowEnd, type QuietHoursPolicy } from './delivery-quiet-hours.js';

/**
 * Sole user-facing outbound delivery port.
 *
 * Application code that talks to a human over a channel should go through this
 * port. `deliverToChannel` remains a low-level transport primitive and must not
 * be called directly for the same class of user-facing messages.
 *
 * Lifecycle for user-facing outbound: draft → confirm (human) → send.
 * `confirm` with `approve` performs confirm+send via the existing release path.
 *
 * Global quiet hours: while the configured window is active, `confirm(approve)` does not send.
 * The draft becomes `deferred` (human approval kept) and `flushDeferred()` releases it once
 * the window has ended. Reject always works, including for deferred drafts.
 */
export interface UserDeliveryMessage {
  channelId: string;
  text: string;
  event?: string;
  receiveId?: string;
  receiveIdType?: FeishuReceiveIdType;
}

export interface UserDeliveryPort {
  /** Hold outbound as a draft. Never POSTs to a channel. */
  draft(message: UserDeliveryMessage): Promise<OutboundDraft>;
  /**
   * Human confirm. `approve` claims and sends; `reject` abandons.
   * This is the only sanctioned way to turn a user-facing draft into a send.
   */
  confirm(input: {
    id: string;
    decision: 'approve' | 'reject';
    /** Revision of the preview the human saw; a stale value fails closed (409). */
    expectedRevision?: number;
  }): Promise<OutboundDraft>;
  /**
   * Human edit of the preview text before confirm. Does not confirm or send;
   * the draft stays `pending_approval` and still needs `confirm`.
   */
  edit(input: { id: string; text: string; expectedRevision?: number }): Promise<OutboundDraft>;
  /** Read pending/historical drafts for this gateway. */
  list(): Promise<OutboundDraft[]>;
  /** Drafts plus the identity each one will send as. */
  listPreviews(): Promise<OutboundDraftPreview[]>;
  /**
   * Send drafts deferred by quiet hours, oldest first. No-op while the window is still active.
   * Returns the ids it attempted; a failed send is left `failed` (retryable) and does not stop the rest.
   */
  flushDeferred(): Promise<string[]>;
}

export interface UserDeliveryPortOptions {
  gatewayDir: string;
  channels: ChannelSpec[];
  /** Read per call so a Lab change applies immediately. Undefined or disabled = no quiet window. */
  quietHours?: () => QuietHoursPolicy | undefined;
  now?: () => number;
}

export function createUserDeliveryPort(opts: UserDeliveryPortOptions): UserDeliveryPort {
  const { gatewayDir, channels } = opts;
  const clock = opts.now ?? Date.now;
  const quiet = () => {
    const policy = opts.quietHours?.();
    return policy && isQuietNow(policy, clock()) ? policy : undefined;
  };
  const release = (id: string) => releaseOutboundDraft({ gatewayDir, id, decision: 'approve', channels });
  return {
    draft(message) {
      return appendOutboundDraft(gatewayDir, {
        channelId: message.channelId,
        text: message.text,
        event: message.event,
        receiveId: message.receiveId,
        receiveIdType: message.receiveIdType
      });
    },
    confirm(input) {
      const policy = input.decision === 'approve' ? quiet() : undefined;
      if (!policy) {
        return releaseOutboundDraft({
          gatewayDir,
          id: input.id,
          decision: input.decision,
          channels,
          expectedRevision: input.expectedRevision
        });
      }
      const end = quietWindowEnd(policy, clock());
      return deferOutboundDraftForQuietHours({
        gatewayDir,
        id: input.id,
        until: end === undefined ? undefined : new Date(end).toISOString(),
        expectedRevision: input.expectedRevision
      });
    },
    edit(input) {
      return editOutboundDraft(gatewayDir, input.id, { text: input.text, expectedRevision: input.expectedRevision });
    },
    list() {
      return readOutboundDrafts(gatewayDir);
    },
    async listPreviews() {
      const drafts = await readOutboundDrafts(gatewayDir);
      return drafts.map((draft) => previewOutboundDraft(draft, channels));
    },
    async flushDeferred() {
      if (quiet()) return [];
      const due = (await readOutboundDrafts(gatewayDir)).filter((draft) => draft.status === 'deferred');
      for (const draft of due) await release(draft.id).catch(() => undefined);
      return due.map((draft) => draft.id);
    }
  };
}
