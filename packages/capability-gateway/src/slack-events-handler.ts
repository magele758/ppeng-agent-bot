/**
 * Slack Events API inbound. A signed user message is addressed as
 * `slack:<channel>:<thread>` and wakes routines listening for `slack/message`.
 * Outbound `chat.postMessage` stays a draft. Feishu is not involved.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import { acceptEventRoutine, type AcceptEventRoutineResult, type EventRoutineHost } from '@ppeng/agent-core';
import { parseSlackEventsBody, verifySlackEventsSignature, type SlackEventsAddress } from './channels/slack-events.js';
import type { GatewaySettings } from './gateway-settings.js';
import { claimInboundEvent, InboundClaimTimeoutError, isSenderAllowed, scheduleGatewayTurn } from './inbound-guard.js';
import { runAgentTurnAndReply } from './im-handlers.js';
import { deliverChannelText } from './outbound.js';
import { readGatewayState } from './state.js';
import type { ChannelSpec, SlackProviderSpec } from './types.js';

export type SlackEventsHttpResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'empty'; status: number };

const log: EventRoutineHost['log'] = {
  debug() {},
  info() {},
  warn(message) {
    console.warn(`[slack-events] ${message}`);
  },
  error(message) {
    console.error(`[slack-events] ${message}`);
  }
};

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function signingSecret(settings: GatewaySettings, spec: SlackProviderSpec): string | undefined {
  return (settings.slack.signingSecret ?? spec.signingSecret)?.trim() || undefined;
}

function forbidden(error: string): SlackEventsHttpResult {
  return { kind: 'json', status: 403, body: { error } };
}

async function claimStop(key: string, gatewayDir: string): Promise<SlackEventsHttpResult | undefined> {
  try {
    const claim = await claimInboundEvent(key, Date.now(), gatewayDir);
    if (claim === 'duplicate') return { kind: 'json', status: 200, body: { ok: true, duplicate: true } };
    return undefined;
  } catch (error) {
    if (error instanceof InboundClaimTimeoutError) {
      return { kind: 'json', status: 503, body: { error: 'Inbound claim lock busy', retryable: true } };
    }
    throw error;
  }
}

type RoutineRuntime = RawAgentRuntime & {
  isSessionRunning?: (sessionId: string) => boolean;
  hasUnconfirmedEffects?: (sessionId: string, startedAt: string) => boolean;
  cancelSession?: (sessionId: string) => unknown;
};

function routineHost(input: { runtime: RoutineRuntime; stateDir: string }): EventRoutineHost {
  const runtime = input.runtime;
  return {
    stateDir: input.stateDir,
    log,
    store: runtime.store,
    runSession: (sessionId) => runtime.runSession(sessionId),
    isSessionRunning: (sessionId) => runtime.isSessionRunning?.(sessionId) ?? false,
    hasUnconfirmedEffects: (sessionId, startedAt) => runtime.hasUnconfirmedEffects?.(sessionId, startedAt) ?? false,
    cancelSession: (sessionId) => runtime.cancelSession?.(sessionId)
  };
}

/** Wake every enabled `slack/message` listener. A listener miss does not fail the channel turn. */
export async function wakeSlackMessageRoutines(input: {
  runtime: RoutineRuntime;
  stateDir: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}): Promise<AcceptEventRoutineResult | undefined> {
  const store = input.runtime.store as { createSession?: unknown };
  if (typeof store.createSession !== 'function') return undefined;
  return acceptEventRoutine(routineHost(input), {
    provider: 'slack',
    rawBody: input.rawBody,
    headers: input.headers,
    body: input.body,
    claimDelivery: async (key) => (await claimInboundEvent(key, Date.now(), input.stateDir)) === 'claimed'
  });
}

function replyChannelOf(spec: SlackProviderSpec, channels: ChannelSpec[], channelId: string): ChannelSpec | undefined {
  const found = spec.replyChannelId
    ? channels.find((channel) => channel.id === spec.replyChannelId && channel.type === 'slack')
    : undefined;
  return found ? { ...found, target: channelId } : undefined;
}

function scheduleSlackTurn(input: {
  runtime: RawAgentRuntime;
  gatewayDir: string;
  address: SlackEventsAddress;
  spec: SlackProviderSpec;
  settings: GatewaySettings;
  channels: ChannelSpec[];
}): void {
  const botId = input.settings.slack.botId ?? input.spec.botId;
  const replyChannel = replyChannelOf(input.spec, input.channels, input.address.channelId);
  const lane = botId ? `bot:${botId}` : input.address.sessionKey;
  scheduleGatewayTurn(lane, () => runSlackTurn(input, botId, replyChannel));
}

async function runSlackTurn(
  input: {
    runtime: RawAgentRuntime;
    gatewayDir: string;
    address: SlackEventsAddress;
    spec: SlackProviderSpec;
  },
  botId: string | undefined,
  replyChannel: ChannelSpec | undefined
): Promise<void> {
  const state = await readGatewayState(input.gatewayDir);
  await runAgentTurnAndReply({
    runtime: input.runtime,
    gatewayDir: input.gatewayDir,
    state,
    sessionKey: input.address.sessionKey,
    userText: input.address.text,
    agentId: input.spec.defaultAgentId ?? 'main',
    botId,
    origin: 'human',
    reply: (text) => draftSlackReply(input.gatewayDir, replyChannel, text)
  });
}

function draftSlackReply(gatewayDir: string, channel: ChannelSpec | undefined, text: string): Promise<void> {
  if (!channel) return Promise.resolve();
  return deliverChannelText({ gatewayDir, channel, text, event: 'gateway.im.reply' });
}

/**
 * Verify, address, and acknowledge one Slack Events request.
 * The channel turn and `slack/message` wake run after the 200 so Slack retries
 * cannot start a second run. URL verification returns the challenge and does not wake.
 */
export async function handleSlackEventsRequest(input: {
  body: unknown;
  rawBody: string;
  headers?: Record<string, string | string[] | undefined>;
  spec: SlackProviderSpec;
  settings: GatewaySettings;
  runtime: RoutineRuntime;
  gatewayDir: string;
  stateDir: string;
  channels: ChannelSpec[];
}): Promise<SlackEventsHttpResult> {
  const secret = signingSecret(input.settings, input.spec);
  if (!secret) return forbidden('Slack signing secret is not configured');
  const signed = verifySlackEventsSignature({
    rawBody: input.rawBody,
    secret,
    timestamp: headerValue(input.headers, 'x-slack-request-timestamp'),
    signature: headerValue(input.headers, 'x-slack-signature')
  });
  if (!signed) return forbidden('Invalid Slack signature');

  const parsed = parseSlackEventsBody(input.body);
  if (parsed.kind === 'url_verification') return { kind: 'challenge', challenge: parsed.challenge ?? '' };
  if (parsed.kind !== 'message' || !parsed.address) return { kind: 'empty', status: 200 };

  const address = parsed.address;
  if (!isSenderAllowed(input.settings.slack.allowedSenders, address.senderId ? [address.senderId] : [])) {
    return { kind: 'empty', status: 200 };
  }
  const claimKey = address.eventId ? `slack:event:${address.eventId}` : `slack:message:${address.conversationKey}:${address.messageTs}`;
  const stopped = await claimStop(claimKey, input.gatewayDir);
  if (stopped) return stopped;

  scheduleSlackTurn({ ...input, address });
  void wakeSlackMessageRoutines({
    runtime: input.runtime,
    stateDir: input.stateDir,
    rawBody: input.rawBody,
    headers: input.headers ?? {},
    body: input.body
  }).catch(() => undefined);
  return { kind: 'empty', status: 200 };
}
