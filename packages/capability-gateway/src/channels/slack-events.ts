/**
 * Slack Events API inbound. This is the product path that turns a signed
 * `event_callback` into a channel/thread address and a `slack/message` wake.
 * Outbound `chat.postMessage` stays in `slack.ts`. Feishu is not involved.
 *
 * @see https://api.slack.com/apis/events-api
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Same window the routine signer already uses for Slack. */
export const SLACK_EVENTS_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const SLACK_ID = /^[A-Z0-9]{1,32}$/;

export interface SlackEventsAddress {
  /** Slack conversation id (`event.channel`). */
  channelId: string;
  /** Thread parent ts. Top-level messages use their own `ts`. */
  threadTs: string;
  /** Stable agent conversation key: `slack:<channel>:<thread>`. */
  conversationKey: string;
  /** Session key the gateway turn sticks to. */
  sessionKey: string;
  /** Schedule value a routine listener matches (`slack/message`). */
  scheduleValue: 'slack/message';
  senderId?: string;
  text: string;
  /** Platform event id, used as the delivery / dedupe key. */
  eventId?: string;
  /** This message's ts, for a thread reply. */
  messageTs?: string;
}

export interface SlackEventsParseResult {
  kind: 'url_verification' | 'message' | 'ignored';
  challenge?: string;
  address?: SlackEventsAddress;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function slackId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return SLACK_ID.test(id) ? id : undefined;
}

function slackTs(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ts = value.trim();
  return /^\d{1,16}\.\d{1,8}$/.test(ts) ? ts : undefined;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function signaturesMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Slack signing secret check: `v0=` + HMAC-SHA256(secret, `v0:{timestamp}:{rawBody}`).
 * A timestamp more than five minutes from now is rejected. Missing secret fails closed.
 */
export function verifySlackEventsSignature(input: {
  rawBody: string;
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  const secret = input.secret?.trim();
  const signature = input.signature?.trim();
  const timestamp = input.timestamp?.trim();
  if (!secret || !signature || !timestamp || !/^\d{1,16}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - seconds * 1000) > SLACK_EVENTS_SIGNATURE_WINDOW_MS) return false;
  const expected = `v0=${hmacHex(secret, `v0:${timestamp}:${input.rawBody}`)}`;
  return signaturesMatch(expected, signature);
}

/**
 * Map one Slack Events body onto the agent addressing model.
 * `url_verification` returns the challenge and does not address a thread.
 * Only a user `message` (not a bot echo, edit, or subtype) becomes an address.
 * A thread reply keys on `thread_ts`; a top-level message keys on its own `ts`.
 */
export function parseSlackEventsBody(body: unknown): SlackEventsParseResult {
  const rec = asRecord(body);
  if (!rec) return { kind: 'ignored' };
  if (rec.type === 'url_verification' && typeof rec.challenge === 'string' && rec.challenge.trim()) {
    return { kind: 'url_verification', challenge: rec.challenge };
  }
  if (rec.type !== 'event_callback') return { kind: 'ignored' };

  const event = asRecord(rec.event);
  if (!event || event.type !== 'message') return { kind: 'ignored' };
  if (typeof event.subtype === 'string' && event.subtype.trim()) return { kind: 'ignored' };
  if (typeof event.bot_id === 'string' && event.bot_id.trim()) return { kind: 'ignored' };

  const channelId = slackId(event.channel);
  const messageTs = slackTs(event.ts);
  const threadTs = slackTs(event.thread_ts) ?? messageTs;
  const text = typeof event.text === 'string' ? event.text.trim() : '';
  if (!channelId || !threadTs || !text) return { kind: 'ignored' };

  const senderId = slackId(event.user);
  const eventId = typeof rec.event_id === 'string' && rec.event_id.trim() ? rec.event_id.trim() : undefined;
  const conversationKey = `slack:${channelId}:${threadTs}`;
  return {
    kind: 'message',
    address: {
      channelId,
      threadTs,
      conversationKey,
      sessionKey: conversationKey,
      scheduleValue: 'slack/message',
      senderId,
      text,
      eventId,
      messageTs
    }
  };
}
