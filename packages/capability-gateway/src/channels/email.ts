import type { ChannelSpec } from '../types.js';
import { resolveHeaderValue } from './credentials.js';
import {
  isHttpUrl,
  redactSecrets,
  stripOutboundFenceMarkers,
  type ChannelDeliveryResult
} from './outbound-body.js';

/**
 * email_http reference sender. POSTs JSON to `channel.url`.
 * No vendor SDK. Auth headers may name an env var; values are not logged.
 */
export async function sendEmailHttp(
  channel: ChannelSpec,
  text: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ChannelDeliveryResult> {
  const bodyText = stripOutboundFenceMarkers(text);
  if (!bodyText) return { ok: false, status: 0, text: 'empty outbound text' };
  const url = channel.url.trim();
  if (!isHttpUrl(url)) return { ok: false, status: 0, text: 'email_http url missing' };
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(channel.headers ?? {})) {
    if (key.toLowerCase() === 'content-type') continue;
    const resolved = resolveHeaderValue(value, env);
    if (!resolved) continue;
    headers[key] = resolved;
    const bearer = resolved.match(/^Bearer\s+(\S+)$/i);
    secrets.push(bearer?.[1] ?? resolved);
  }
  const to = channel.target?.trim();
  const subject = channel.subject?.trim();
  const payload = {
    transport: 'email_http',
    text: bodyText,
    ...(to ? { to } : {}),
    ...(subject ? { subject } : {})
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000)
    });
    await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, status: res.status, text: redactSecrets(`email_http http ${res.status}`, secrets) };
    }
    return { ok: true, status: res.status, text: 'ok' };
  } catch {
    return { ok: false, status: 0, text: 'email_http request failed' };
  }
}
