import { env } from 'node:process';
import { requireHumanEgressApproval } from '@ppeng/agent-core';
import { sendEmailHttp } from './channels/email.js';
import { channelMessageText } from './channels/outbound-body.js';
import { sendSlackChatMessage } from './channels/slack.js';
import { sendTelegramMessage } from './channels/telegram.js';
import { sendFeishuTextMessage } from './feishu-api.js';
import type { ChannelSpec } from './types.js';
import { buildWeComWebhookUrl, sendWeComGroupBotMarkdown } from './wecom-send.js';

export async function deliverToChannel(
  channel: ChannelSpec,
  body: Record<string, unknown>,
  opts?: { approval?: string; claimedFrom?: string; requireEmailFrom?: boolean }
): Promise<{ ok: boolean; status: number; text: string }> {
  requireHumanEgressApproval(opts?.approval);
  if (channel.type === 'feishu_bot') {
    const appId = env.RAW_AGENT_FEISHU_APP_ID?.trim();
    const appSecret = env.RAW_AGENT_FEISHU_APP_SECRET?.trim();
    if (!appId || !appSecret || !channel.url.trim()) {
      return { ok: false, status: 0, text: 'feishu_bot channel needs url (receive_id) and RAW_AGENT_FEISHU_APP_ID/SECRET' };
    }
    const text =
      typeof body.text === 'string'
        ? body.text
        : typeof body.summary === 'string'
          ? body.summary
          : JSON.stringify(body);
    try {
      await sendFeishuTextMessage({
        appId,
        appSecret,
        receiveId: channel.url.trim(),
        receiveIdType: channel.feishuReceiveIdType ?? 'open_id',
        text
      });
      return { ok: true, status: 200, text: 'ok' };
    } catch (e) {
      return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
    }
  }

  if (channel.type === 'wecom_group_bot') {
    const hook = buildWeComWebhookUrl(channel.url, channel.wecomKey);
    const md =
      typeof body.text === 'string'
        ? body.text
        : typeof body.summary === 'string'
          ? body.summary
          : '```json\n' + JSON.stringify(body, null, 2).slice(0, 3500) + '\n```';
    try {
      await sendWeComGroupBotMarkdown(hook, md);
      return { ok: true, status: 200, text: 'ok' };
    } catch (e) {
      return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
    }
  }

  if (channel.type === 'slack' || channel.type === 'telegram' || channel.type === 'email') {
    const text = channelMessageText(body);
    if (channel.type === 'slack') return sendSlackChatMessage(channel, text);
    if (channel.type === 'telegram') return sendTelegramMessage(channel, text);
    return sendEmailHttp(channel, text, env, {
      claimedFrom: opts?.claimedFrom,
      requireFrom: opts?.requireEmailFrom
    });
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'raw-agent-capability-gateway/0.1',
    ...channel.headers
  };
  let payload: string;
  if (channel.payloadMode === 'json_text') {
    payload = JSON.stringify({
      text: typeof body.text === 'string' ? body.text : JSON.stringify(body)
    });
  } else {
    payload = JSON.stringify(body);
  }
  const res = await fetch(channel.url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text: text.slice(0, 2000) };
}
