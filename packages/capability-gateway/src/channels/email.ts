import type { ChannelSpec } from '../types.js';
import { resolveEmailOutboundFrom } from '../outbound-identity.js';
import { resolveHeaderValue } from './credentials.js';
import {
  isHttpUrl,
  redactSecrets,
  stripOutboundFenceMarkers,
  type ChannelDeliveryResult
} from './outbound-body.js';

export interface SendEmailHttpOptions {
  /**
   * Claimed agent-inbox address used only when `channel.from` is empty.
   * Explicit `channel.from` always wins. When neither is set, `from` is omitted
   * from the JSON body (legacy relay); callers that require a from should check
   * `resolveEmailOutboundFrom` / identity.resolved first.
   */
  claimedFrom?: string;
  /**
   * When true, refuse to POST if neither channel.from nor claimedFrom resolves.
   * Default false preserves legacy email_http relays that omit from.
   */
  requireFrom?: boolean;
  /**
   * Draft-level In-Reply-To override. Wins over `channel.inReplyTo` when set.
   */
  inReplyTo?: string;
  /**
   * Draft-level References override. Wins over `channel.references` when set.
   */
  references?: string;
  /**
   * Draft-level subject override. When provided (including empty string), used
   * instead of `channel.subject` for resolveEmailReplySubject.
   */
  subject?: string;
  /**
   * Original subject of the claimed-inbox message being replied to.
   * Used for Re: defaulting when the effective subject is empty.
   */
  replyToSubject?: string;
}

/**
 * Resolve the email_http subject for a send / preview.
 * Explicit subject (non-empty after trim) always wins.
 * When subject is empty and `replyToSubject` is set (claimed-inbox reply),
 * default to `Re: <original>` (without doubling an existing Re: prefix).
 */
export function resolveEmailReplySubject(input: {
  subject?: string;
  replyToSubject?: string;
}): string | undefined {
  const explicit = input.subject?.trim();
  if (explicit) return explicit;
  const original = input.replyToSubject?.trim();
  if (!original) return undefined;
  if (/^re:\s/i.test(original)) return original;
  return `Re: ${original}`;
}

/**
 * email_http reference sender. POSTs JSON to `channel.url`.
 * No vendor SDK. Auth headers may name an env var; values are not logged.
 *
 * From precedence (r5-22): channel.from > claimedFrom > omit/fail when requireFrom.
 * Reply threading (r5-24): optional inReplyTo / references on payload; subject
 * defaults to Re: <original> when empty and replyToSubject is provided.
 */
export async function sendEmailHttp(
  channel: ChannelSpec,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: SendEmailHttpOptions
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
  const subjectSource =
    options && Object.prototype.hasOwnProperty.call(options, 'subject')
      ? options.subject
      : channel.subject;
  const subject = resolveEmailReplySubject({
    subject: subjectSource,
    replyToSubject: options?.replyToSubject ?? undefined
  });
  const emailFrom = resolveEmailOutboundFrom(channel, options?.claimedFrom);
  if (options?.requireFrom && !emailFrom.resolved) {
    return { ok: false, status: 0, text: 'email_http from unresolved (no channel.from and no claimed inbox)' };
  }
  const from = emailFrom.from;
  const inReplyTo =
    (options?.inReplyTo?.trim() || channel.inReplyTo?.trim() || undefined) || undefined;
  const referencesExplicit =
    (options?.references?.trim() || channel.references?.trim() || undefined) || undefined;
  const references = referencesExplicit || (inReplyTo ? inReplyTo : undefined);
  const payload = {
    transport: 'email_http',
    text: bodyText,
    ...(to ? { to } : {}),
    ...(subject ? { subject } : {}),
    ...(from ? { from } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {})
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
