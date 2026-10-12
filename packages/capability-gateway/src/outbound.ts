import { env } from 'node:process';
import { NotFoundError, ValidationError } from '@ppeng/agent-core';
import { deliverToChannel } from './channels.js';
import { recoverOutboundLedger, sendLedgered, type DeliveryRow } from './delivery-ledger.js';
import { sendFeishuTextMessage } from './feishu-api.js';
import {
  appendOutboundDraft,
  claimOutboundDraft,
  OutboundDraftError,
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
}): Promise<void> {
  await sendLedgered({
    gatewayDir: opts.gatewayDir,
    target: { type: 'channel', channelId: opts.channel.id },
    text: opts.text,
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
      return await rejectOutboundDraft(input.gatewayDir, input.id);
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
  try {
    if (draft.receiveId && draft.receiveIdType) {
      const receiveId = draft.receiveId;
      const receiveIdType = draft.receiveIdType;
      await sendLedgered({
        gatewayDir: input.gatewayDir,
        target: { type: 'feishu', receiveId, receiveIdType },
        text: draft.text,
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
        event: draft.event
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

/** Replay unconfirmed outbound IM after process start. Failures stay on the ledger. */
export async function recoverGatewayOutbound(input: {
  gatewayDir: string;
  channels: ChannelSpec[];
}): Promise<number> {
  return recoverOutboundLedger(input.gatewayDir, (row, text) => resendRow(row, text, input.channels));
}
