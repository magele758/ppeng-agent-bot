import type { ChannelSpec } from '../types.js';
import { channelToken, tokenFitsUrlPath } from './credentials.js';
import {
  isHttpUrl,
  redactSecrets,
  stripOutboundFenceMarkers,
  type ChannelDeliveryResult
} from './outbound-body.js';

const DEFAULT_ORIGIN = 'https://api.telegram.org';

/**
 * Telegram Bot API `sendMessage`. The token is placed in the URL path as the Bot API requires.
 * Callers must not log the request URL. Transport failures return a fixed string so the token cannot leak.
 * @see https://core.telegram.org/bots/api#sendmessage
 */
export async function sendTelegramMessage(
  channel: ChannelSpec,
  text: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ChannelDeliveryResult> {
  const bodyText = stripOutboundFenceMarkers(text);
  if (!bodyText) return { ok: false, status: 0, text: 'empty outbound text' };
  const token = channelToken(channel, env);
  if (!token) return { ok: false, status: 0, text: 'telegram token missing' };
  if (!tokenFitsUrlPath(token)) return { ok: false, status: 0, text: 'telegram token rejected' };
  const destination = telegramDestination(channel, token);
  if (!destination) return { ok: false, status: 0, text: 'telegram chat id missing' };
  try {
    const res = await fetch(destination.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: destination.chatId, text: bodyText }),
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await res.text().catch(() => '');
    return telegramResult(res.status, res.ok, raw, token);
  } catch {
    return { ok: false, status: 0, text: 'telegram request failed' };
  }
}

function telegramDestination(
  channel: ChannelSpec,
  token: string
): { url: string; chatId: string } | undefined {
  const url = channel.url.trim();
  const target = channel.target?.trim() ?? '';
  const chatId = target || (isHttpUrl(url) ? '' : url);
  if (!chatId) return undefined;
  const origin = (isHttpUrl(url) ? url : DEFAULT_ORIGIN).replace(/\/$/, '');
  return { url: `${origin}/bot${token}/sendMessage`, chatId };
}

function telegramResult(status: number, httpOk: boolean, raw: string, token: string): ChannelDeliveryResult {
  let apiOk = false;
  let apiFailed = false;
  let description: string | undefined;
  try {
    const data = JSON.parse(raw) as { ok?: boolean; description?: string };
    if (data.ok === true) apiOk = true;
    if (data.ok === false) {
      apiFailed = true;
      if (typeof data.description === 'string') description = data.description;
    }
  } catch {
    description = undefined;
  }
  if (apiOk && !apiFailed) return { ok: true, status, text: 'ok' };
  if (!apiFailed && httpOk) return { ok: true, status, text: 'ok' };
  const detail = description ? `telegram error: ${description}` : `telegram http ${status}`;
  return { ok: false, status, text: redactSecrets(detail, [token]).slice(0, 500) };
}
