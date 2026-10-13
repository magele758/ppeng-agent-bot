import type { ChannelSpec } from '../types.js';
import { channelToken } from './credentials.js';
import {
  isHttpUrl,
  redactSecrets,
  stripOutboundFenceMarkers,
  type ChannelDeliveryResult
} from './outbound-body.js';

const DEFAULT_ENDPOINT = 'https://slack.com/api/chat.postMessage';

/**
 * Slack Web API `chat.postMessage`. Token comes from `tokenEnv` or the Authorization header.
 * The token is sent as a bearer header and is not included in errors or logs.
 * @see https://api.slack.com/methods/chat.postMessage
 */
export async function sendSlackChatMessage(
  channel: ChannelSpec,
  text: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ChannelDeliveryResult> {
  const bodyText = stripOutboundFenceMarkers(text);
  if (!bodyText) return { ok: false, status: 0, text: 'empty outbound text' };
  const token = channelToken(channel, env);
  if (!token) return { ok: false, status: 0, text: 'slack token missing' };
  const destination = slackDestination(channel);
  if (!destination) return { ok: false, status: 0, text: 'slack channel id missing' };
  try {
    const res = await fetch(destination.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ channel: destination.conversation, text: bodyText }),
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await res.text().catch(() => '');
    return slackResult(res.status, res.ok, raw, token);
  } catch {
    return { ok: false, status: 0, text: 'slack request failed' };
  }
}

function slackDestination(channel: ChannelSpec): { endpoint: string; conversation: string } | undefined {
  const url = channel.url.trim();
  const target = channel.target?.trim() ?? '';
  if (isHttpUrl(url)) {
    if (!target) return undefined;
    return { endpoint: url, conversation: target };
  }
  const conversation = target || url;
  if (!conversation) return undefined;
  return { endpoint: DEFAULT_ENDPOINT, conversation };
}

function slackResult(status: number, httpOk: boolean, raw: string, token: string): ChannelDeliveryResult {
  let apiError: string | undefined;
  let apiOk = false;
  try {
    const data = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (data.ok === true) apiOk = true;
    if (data.ok === false) apiError = typeof data.error === 'string' ? data.error : 'slack_error';
  } catch {
    apiError = undefined;
  }
  if (apiOk && httpOk) return { ok: true, status, text: 'ok' };
  if (httpOk && !apiError) return { ok: true, status, text: 'ok' };
  const detail = apiError ? `slack error: ${apiError}` : `slack http ${status}`;
  return { ok: false, status, text: redactSecrets(detail, [token]).slice(0, 500) };
}
