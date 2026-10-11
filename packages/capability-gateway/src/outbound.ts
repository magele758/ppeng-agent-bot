import { env } from 'node:process';
import { deliverToChannel } from './channels.js';
import { recoverOutboundLedger, sendLedgered, type DeliveryRow } from './delivery-ledger.js';
import { sendFeishuTextMessage } from './feishu-api.js';
import type { ChannelSpec } from './types.js';

export async function deliverChannelText(opts: {
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
      const result = await deliverToChannel(opts.channel, {
        text,
        event: opts.event ?? 'gateway.im.reply'
      });
      if (!result.ok) throw new Error(result.text || 'delivery failed');
    }
  });
}

async function resendRow(row: DeliveryRow, text: string, channels: ChannelSpec[]): Promise<void> {
  const target = row.target;
  switch (target.type) {
    case 'channel': {
      const channel = channels.find((item) => item.id === target.channelId);
      if (!channel) throw new Error(`missing channel ${target.channelId}`);
      const result = await deliverToChannel(channel, { text, event: 'gateway.im.reply' });
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
