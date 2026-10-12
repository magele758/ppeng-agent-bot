import { env } from 'node:process';
import { NotFoundError, ValidationError } from '@ppeng/agent-core';
import { deliverToChannel } from './channels.js';
import {
  abandonDraftDeliveries,
  closeUnconfirmedDraft,
  quarantineUnlinkedDraftRows,
  recoverOutboundLedger,
  sendLedgered,
  type DeliveryRow,
  type LegacyDraftMatch
} from './delivery-ledger.js';
import { sendFeishuTextMessage } from './feishu-api.js';
import {
  appendOutboundDraft,
  claimOutboundDraft,
  OutboundDraftError,
  readOutboundDrafts,
  rejectOutboundDraft,
  settleOutboundDraft,
  type OutboundDraft
} from './outbound-drafts.js';
import type { ChannelSpec } from './types.js';

export async function deliverChannelText(opts: {
  gatewayDir: string;
  channel: ChannelSpec;
  text: string;
  event?: string;
  /** Conversational replies and a human draft release pass `approved`. Anything else is held as a draft. */
  approval?: 'approved';
}): Promise<void> {
  if (opts.approval !== 'approved') {
    await appendOutboundDraft(opts.gatewayDir, {
      channelId: opts.channel.id,
      text: opts.text,
      event: opts.event ?? 'gateway.im.reply'
    });
    return;
  }
  await sendApprovedChannel(opts);
}

async function sendApprovedChannel(opts: {
  gatewayDir: string;
  channel: ChannelSpec;
  text: string;
  event?: string;
  draftId?: string;
}): Promise<void> {
  await sendLedgered({
    gatewayDir: opts.gatewayDir,
    target: { type: 'channel', channelId: opts.channel.id },
    text: opts.text,
    draftId: opts.draftId,
    send: async (text) => {
      const result = await deliverToChannel(
        opts.channel,
        {
          text,
          event: opts.event ?? 'gateway.im.reply'
        },
        { approval: 'approved' }
      );
      if (!result.ok) throw new Error(result.text || 'delivery failed');
    }
  });
}

function rethrowDraft(error: unknown): never {
  if (error instanceof OutboundDraftError && error.code === 'not_found') {
    throw new NotFoundError('OutboundDraft', error.draftId);
  }
  if (error instanceof OutboundDraftError) throw new ValidationError(error.message);
  throw error;
}

/**
 * Human inbox action. `decision` is chosen by the route, never by model text or a request body.
 * Approve sends; reject does not.
 */
export async function releaseOutboundDraft(input: {
  gatewayDir: string;
  id: string;
  decision: 'approve' | 'reject';
  channels: ChannelSpec[];
}): Promise<OutboundDraft> {
  if (input.decision === 'reject') {
    try {
      const draft = await rejectOutboundDraft(input.gatewayDir, input.id);
      await abandonDraftDeliveries(input.gatewayDir, draft.id);
      await quarantineLegacyRowsForDraft(input.gatewayDir, draft);
      return draft;
    } catch (error) {
      rethrowDraft(error);
    }
  }
  let draft: OutboundDraft;
  try {
    draft = await claimOutboundDraft(input.gatewayDir, input.id);
  } catch (error) {
    rethrowDraft(error);
  }
  await quarantineLegacyRowsForDraft(input.gatewayDir, draft);
  try {
    if (draft.receiveId && draft.receiveIdType) {
      const receiveId = draft.receiveId;
      const receiveIdType = draft.receiveIdType;
      await sendLedgered({
        gatewayDir: input.gatewayDir,
        target: { type: 'feishu', receiveId, receiveIdType },
        text: draft.text,
        draftId: draft.id,
        send: async (out) => {
          const appId = env.RAW_AGENT_FEISHU_APP_ID?.trim();
          const appSecret = env.RAW_AGENT_FEISHU_APP_SECRET?.trim();
          if (!appId || !appSecret) throw new Error('feishu credentials missing');
          await sendFeishuTextMessage({ appId, appSecret, receiveId, receiveIdType, text: out });
        }
      });
    } else {
      const channel = input.channels.find((item) => item.id === draft.channelId);
      if (!channel) throw new Error(`missing channel ${draft.channelId}`);
      await sendApprovedChannel({
        gatewayDir: input.gatewayDir,
        channel,
        text: draft.text,
        event: draft.event,
        draftId: draft.id
      });
    }
    return await settleOutboundDraft(input.gatewayDir, draft.id, { status: 'sent' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settleOutboundDraft(input.gatewayDir, draft.id, { status: 'failed', error: message }).catch(() => undefined);
    throw error;
  }
}

async function resendRow(row: DeliveryRow, text: string, channels: ChannelSpec[]): Promise<void> {
  const target = row.target;
  switch (target.type) {
    case 'channel': {
      const channel = channels.find((item) => item.id === target.channelId);
      if (!channel) throw new Error(`missing channel ${target.channelId}`);
      const result = await deliverToChannel(channel, { text, event: 'gateway.im.reply' }, { approval: 'approved' });
      if (!result.ok) throw new Error(result.text || 'delivery failed');
      return;
    }
    case 'feishu': {
      const appId = env.RAW_AGENT_FEISHU_APP_ID?.trim();
      const appSecret = env.RAW_AGENT_FEISHU_APP_SECRET?.trim();
      if (!appId || !appSecret) throw new Error('feishu credentials missing');
      await sendFeishuTextMessage({
        appId,
        appSecret,
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        text
      });
      return;
    }
    default: {
      const neverTarget: never = target;
      throw new Error(`unknown delivery target ${JSON.stringify(neverTarget)}`);
    }
  }
}

const INTERRUPTED_DRAFT_ERROR = 'interrupted before delivery was confirmed';

async function markDraftSentIfRetryable(gatewayDir: string, draftId: string): Promise<void> {
  const draft = (await readOutboundDrafts(gatewayDir)).find((item) => item.id === draftId);
  if (!draft) return;
  if (draft.status !== 'failed' && draft.status !== 'sending') return;
  await settleOutboundDraft(gatewayDir, draftId, { status: 'sent' });
}

/** Crash after claim leaves `sending`. Ledger delivered → sent; otherwise failed and retryable. */
export async function reconcileSendingDrafts(gatewayDir: string): Promise<number> {
  const sending = (await readOutboundDrafts(gatewayDir)).filter((draft) => draft.status === 'sending');
  for (const draft of sending) {
    const delivered = await closeUnconfirmedDraft(gatewayDir, draft.id);
    await settleOutboundDraft(
      gatewayDir,
      draft.id,
      delivered ? { status: 'sent' } : { status: 'failed', error: INTERRUPTED_DRAFT_ERROR }
    );
  }
  return sending.length;
}

async function cancelRejectedDraftReplays(gatewayDir: string): Promise<void> {
  const rejected = (await readOutboundDrafts(gatewayDir)).filter((draft) => draft.status === 'rejected');
  for (const draft of rejected) await abandonDraftDeliveries(gatewayDir, draft.id);
}

function legacyMatchFromDraft(draft: OutboundDraft): LegacyDraftMatch {
  return {
    text: draft.text,
    channelId: draft.channelId,
    ...(draft.receiveId && draft.receiveIdType
      ? { receiveId: draft.receiveId, receiveIdType: draft.receiveIdType }
      : {}),
    createdAt: draft.createdAt
  };
}

/** Isolate one draft's pre-draftId rows. Same match as startup. Does not send. */
export async function quarantineLegacyRowsForDraft(gatewayDir: string, draft: OutboundDraft): Promise<number> {
  return quarantineUnlinkedDraftRows(gatewayDir, [legacyMatchFromDraft(draft)]);
}

/** Isolate pre-draftId ledger rows that match a draft's recipient and time window. Does not send. */
export async function quarantineLegacyDraftLedger(gatewayDir: string): Promise<number> {
  const drafts = await readOutboundDrafts(gatewayDir);
  return quarantineUnlinkedDraftRows(gatewayDir, drafts.map(legacyMatchFromDraft));
}

async function replayRow(gatewayDir: string, row: DeliveryRow, text: string, channels: ChannelSpec[]): Promise<void> {
  await resendRow(row, text, channels);
  if (row.draftId) await markDraftSentIfRetryable(gatewayDir, row.draftId);
}

/** Replay unconfirmed outbound IM after process start. Rejected drafts are not replayed. */
export async function recoverGatewayOutbound(input: {
  gatewayDir: string;
  channels: ChannelSpec[];
}): Promise<number> {
  await reconcileSendingDrafts(input.gatewayDir);
  await cancelRejectedDraftReplays(input.gatewayDir);
  await quarantineLegacyDraftLedger(input.gatewayDir);
  return recoverOutboundLedger(input.gatewayDir, (row, text) => replayRow(input.gatewayDir, row, text, input.channels));
}
