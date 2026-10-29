import type { ChannelSpec } from './types.js';
import {
  appendOutboundDraft,
  readOutboundDrafts,
  type FeishuReceiveIdType,
  type OutboundDraft
} from './outbound-drafts.js';
import { releaseOutboundDraft } from './outbound.js';

/**
 * Sole user-facing outbound delivery port.
 *
 * Application code that talks to a human over a channel should go through this
 * port. `deliverToChannel` remains a low-level transport primitive and must not
 * be called directly for the same class of user-facing messages.
 *
 * Lifecycle for user-facing outbound: draft → confirm (human) → send.
 * `confirm` with `approve` performs confirm+send via the existing release path.
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
  confirm(input: { id: string; decision: 'approve' | 'reject' }): Promise<OutboundDraft>;
  /** Read pending/historical drafts for this gateway. */
  list(): Promise<OutboundDraft[]>;
}

export interface UserDeliveryPortOptions {
  gatewayDir: string;
  channels: ChannelSpec[];
}

export function createUserDeliveryPort(opts: UserDeliveryPortOptions): UserDeliveryPort {
  const { gatewayDir, channels } = opts;
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
      return releaseOutboundDraft({
        gatewayDir,
        id: input.id,
        decision: input.decision,
        channels
      });
    },
    list() {
      return readOutboundDrafts(gatewayDir);
    }
  };
}
