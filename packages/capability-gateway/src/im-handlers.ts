import { createHash } from 'node:crypto';
import { fenceExternalContent, type RawAgentRuntime } from '@ppeng/agent-core';
import { decryptFeishuEncryptPayload } from './feishu-crypto.js';
import type { ChannelSpec, FeishuProviderSpec, WeComProviderSpec } from './types.js';
import { readGatewayState, writeGatewayState, type GatewayPersistedState } from './state.js';
import type { GatewaySettings } from './gateway-settings.js';
import { createUserDeliveryPort } from './user-delivery-port.js';
import { deliverChannelText } from './outbound.js';
import { resolveImOutbound, type ImTurnOrigin, type SilentAckLocale } from './silent-reply.js';
import {
  claimInboundEvent,
  InboundClaimTimeoutError,
  inboundTimestampFresh,
  isSenderAllowed,
  safeEqual,
  scheduleGatewayTurn,
  verifyFeishuSignature
} from './inbound-guard.js';

function portDraft(
  gatewayDir: string,
  input: {
    channelId: string;
    text: string;
    event?: string;
    receiveId?: string;
    receiveIdType?: import('./outbound-drafts.js').FeishuReceiveIdType;
  },
  channels: import('./types.js').ChannelSpec[] = []
) {
  return createUserDeliveryPort({ gatewayDir, channels }).draft(input);
}


function fenceImInbound(text: string, label: string): string {
  return fenceExternalContent({ source: 'im', label, body: text });
}

function parseJsonContent(raw: string): { text?: string } {
  try {
    return JSON.parse(raw) as { text?: string };
  } catch {
    return {};
  }
}

function unwrapFeishuBody(raw: Record<string, unknown>, encryptKey?: string): Record<string, unknown> {
  const enc = raw.encrypt;
  if (typeof enc === 'string' && encryptKey) {
    const decrypted = decryptFeishuEncryptPayload(enc, encryptKey);
    return JSON.parse(decrypted) as Record<string, unknown>;
  }
  return raw;
}

/** Exported for tests / adapters. */
export function feishuUrlVerificationResponse(body: Record<string, unknown>): { challenge: string } | null {
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return { challenge: body.challenge };
  }
  return null;
}

export interface FeishuInboundText {
  text: string;
  /** Key for sticky session */
  sessionKey: string;
  /** Where to reply */
  receiveId: string;
  receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'chat_id';
  /** Every identifier that may appear in a sender allowlist (user ids + chat id). */
  senderIds: string[];
  /** Platform message id, used as dedupe fallback when the envelope has no event_id. */
  messageId?: string;
}

/** Exported for tests / adapters. */
export function extractFeishuInboundText(body: Record<string, unknown>): FeishuInboundText | null {
  const header = body.header as Record<string, unknown> | undefined;
  const eventType = typeof header?.event_type === 'string' ? header.event_type : '';
  if (eventType && !eventType.includes('message')) {
    return null;
  }

  const event = (body.event ?? body) as Record<string, unknown>;
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) {
    return null;
  }

  const messageType = String(message.message_type ?? '');
  if (messageType && messageType !== 'text') {
    return null;
  }

  const contentRaw = typeof message.content === 'string' ? message.content : '';
  const { text } = parseJsonContent(contentRaw);
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }

  const chatId = typeof message.chat_id === 'string' ? message.chat_id : '';
  const sender = event.sender as Record<string, unknown> | undefined;
  const senderId = sender?.sender_id as Record<string, unknown> | undefined;
  const openId =
    typeof senderId?.open_id === 'string'
      ? senderId.open_id
      : typeof senderId?.user_id === 'string'
        ? senderId.user_id
        : '';

  const senderIds = [
    openId,
    typeof senderId?.user_id === 'string' ? senderId.user_id : '',
    typeof senderId?.union_id === 'string' ? senderId.union_id : '',
    chatId
  ].filter(Boolean);
  const messageId = typeof message.message_id === 'string' ? message.message_id : undefined;

  const chatType = String(message.chat_type ?? '');
  if (chatId && (chatType === 'group' || chatType === 'topic')) {
    return {
      text: trimmed,
      sessionKey: `feishu:chat:${chatId}`,
      receiveId: chatId,
      receiveIdType: 'chat_id',
      senderIds,
      messageId
    };
  }

  if (openId) {
    return {
      text: trimmed,
      sessionKey: `feishu:user:${openId}`,
      receiveId: openId,
      receiveIdType: 'open_id',
      senderIds,
      messageId
    };
  }

  if (chatId) {
    return {
      text: trimmed,
      sessionKey: `feishu:chat:${chatId}`,
      receiveId: chatId,
      receiveIdType: 'chat_id',
      senderIds,
      messageId
    };
  }

  return null;
}

/**
 * Bot forever-chat commands (`/new`, `/stop`, `/model`) on a canonical session.
 * Missing on older doubles — callers then keep the normal turn path.
 */
export async function tryBotChatCommand(
  runtime: {
    handleBotChatCommand?: (sessionId: string, text: string) => Promise<{ reply: string } | null>;
  },
  sessionId: string,
  text: string
): Promise<{ reply: string } | null> {
  if (typeof runtime.handleBotChatCommand !== 'function') return null;
  return runtime.handleBotChatCommand(sessionId, text);
}

export async function runAgentTurnAndReply(input: {
  runtime: RawAgentRuntime;
  gatewayDir: string;
  state: GatewayPersistedState;
  sessionKey: string;
  userText: string;
  agentId: string;
  reply: (text: string) => Promise<void>;
  stickySession?: boolean;
  /** Land the turn in this Bot's canonical session instead of an `IM …` session. */
  botId?: string;
  /** Human chats get a short ack instead of a lone silence token. Cron and webhooks stay quiet. */
  origin?: ImTurnOrigin;
  locale?: SilentAckLocale;
}): Promise<{ sessionId: string; outboundText: string | null }> {
  if (input.botId) {
    const { sessionId } = input.runtime.openBot(input.botId);
    const command = await tryBotChatCommand(input.runtime, sessionId, input.userText);
    if (command) {
      await input.reply(command.reply);
      return { sessionId, outboundText: command.reply };
    }
    input.runtime.sendUserMessage(sessionId, fenceImInbound(input.userText, input.sessionKey));
    await input.runtime.runSession(sessionId);
    return finishImReply(input, sessionId);
  }

  const sticky = input.stickySession !== false;
  const map = { ...(input.state.channelSessions ?? {}) };
  let sessionId = sticky ? map[input.sessionKey]?.sessionId : undefined;

  const fenced = fenceImInbound(input.userText, input.sessionKey);
  if (sessionId) {
    input.runtime.sendUserMessage(sessionId, fenced);
  } else {
    const session = input.runtime.createChatSession({
      title: `IM ${input.sessionKey.slice(0, 40)}`,
      message: fenced,
      agentId: input.agentId,
      background: false
    });
    sessionId = session.id;
    if (sticky) {
      map[input.sessionKey] = { sessionId, updatedAt: new Date().toISOString() };
      input.state.channelSessions = map;
      await writeGatewayState(input.gatewayDir, input.state);
    }
  }

  await input.runtime.runSession(sessionId);

  if (sticky && map[input.sessionKey]?.sessionId !== sessionId) {
    map[input.sessionKey] = { sessionId, updatedAt: new Date().toISOString() };
    input.state.channelSessions = map;
    await writeGatewayState(input.gatewayDir, input.state);
  }

  return finishImReply(input, sessionId);
}

async function finishImReply(
  input: {
    runtime: RawAgentRuntime;
    userText: string;
    origin?: ImTurnOrigin;
    locale?: SilentAckLocale;
    reply: (text: string) => Promise<void>;
  },
  sessionId: string
): Promise<{ sessionId: string; outboundText: string | null }> {
  const raw = input.runtime.getLatestAssistantText(sessionId);
  const answer = raw ?? '(无回复)';
  const decision = resolveImOutbound(answer, {
    origin: input.origin ?? 'human',
    locale: input.locale,
    userText: input.userText
  });
  if (decision.action === 'drop') return { sessionId, outboundText: null };
  await input.reply(decision.text);
  return { sessionId, outboundText: decision.text };
}

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function feishuEventToken(body: Record<string, unknown>): string | undefined {
  const header = body.header as Record<string, unknown> | undefined;
  const t = header?.token ?? body.token;
  return typeof t === 'string' ? t : undefined;
}

function feishuEventKey(body: Record<string, unknown>, inbound: FeishuInboundText): string | undefined {
  const header = body.header as Record<string, unknown> | undefined;
  const eventId = typeof header?.event_id === 'string' ? header.event_id : undefined;
  if (eventId) return `feishu:event:${eventId}`;
  return inbound.messageId ? `feishu:message:${inbound.messageId}` : undefined;
}

const forbidden = (error: string) => ({ kind: 'json' as const, status: 403, body: { error } });

type FeishuClaimStop =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'empty'; status: number };

/** Duplicate stays a 200 ack. A lock timeout is 503 so the platform redelivers. */
async function feishuClaimStop(key: string | undefined, gatewayDir: string): Promise<FeishuClaimStop | undefined> {
  if (!key) return undefined;
  const claim = await claimOrBusy(key, gatewayDir);
  if (claim === 'duplicate') return { kind: 'empty', status: 200 };
  if (claim === 'busy') return { kind: 'json', status: 503, body: { error: 'Inbound claim lock busy', retryable: true } };
  return undefined;
}

async function wecomClaimStop(
  key: string,
  gatewayDir: string
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const claim = await claimOrBusy(key, gatewayDir);
  if (claim === 'duplicate') return { status: 200, body: { ok: true, duplicate: true } };
  if (claim === 'busy') return { status: 503, body: { error: 'Inbound claim lock busy', retryable: true } };
  return undefined;
}

async function claimOrBusy(key: string, gatewayDir: string): Promise<'claimed' | 'duplicate' | 'busy'> {
  try {
    return await claimInboundEvent(key, Date.now(), gatewayDir);
  } catch (error) {
    if (error instanceof InboundClaimTimeoutError) return 'busy';
    throw error;
  }
}

/**
 * Verify, dedupe and acknowledge a Feishu event. The agent turn runs in the
 * background so the platform gets its 200 inside its timeout and a retry
 * cannot start a second run.
 */
export async function handleFeishuEventRequest(input: {
  body: Record<string, unknown>;
  /** Exact request bytes as UTF-8; required to verify X-Lark-Signature. */
  rawBody?: string;
  headers?: Record<string, string | string[] | undefined>;
  spec: FeishuProviderSpec;
  settings: GatewaySettings;
  runtime: RawAgentRuntime;
  gatewayDir: string;
  channels: ChannelSpec[];
}): Promise<
  | { kind: 'challenge'; challenge: string }
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'empty'; status: number }
> {
  const encryptKey = input.settings.feishu.encryptKey ?? input.spec.encryptKey;
  const verificationToken = input.settings.feishu.verificationToken ?? input.spec.verificationToken;

  if (encryptKey) {
    const ok = verifyFeishuSignature({
      rawBody: input.rawBody ?? JSON.stringify(input.body),
      encryptKey,
      timestamp: headerValue(input.headers, 'x-lark-request-timestamp'),
      nonce: headerValue(input.headers, 'x-lark-request-nonce'),
      signature: headerValue(input.headers, 'x-lark-signature')
    });
    if (!ok) return forbidden('Invalid Feishu signature');
  }

  let unwrapped: Record<string, unknown>;
  try {
    unwrapped = unwrapFeishuBody(input.body, encryptKey);
  } catch {
    return { kind: 'json', status: 400, body: { error: 'Invalid encrypted payload' } };
  }

  if (verificationToken) {
    const got = feishuEventToken(unwrapped);
    if (!got || !safeEqual(got, verificationToken)) return forbidden('Invalid verification token');
  }

  const challenge = feishuUrlVerificationResponse(unwrapped);
  if (challenge) {
    return { kind: 'challenge', challenge: challenge.challenge };
  }

  // Fail closed: without a token or encrypt key nothing proves the event came from Feishu.
  if (!verificationToken && !encryptKey) {
    return forbidden('Feishu inbound verification is not configured (set verification token or encrypt key)');
  }

  const inbound = extractFeishuInboundText(unwrapped);
  if (!inbound) {
    return { kind: 'empty', status: 200 };
  }

  if (!isSenderAllowed(input.settings.feishu.allowedSenders, inbound.senderIds)) {
    return { kind: 'empty', status: 200 };
  }

  const eventKey = feishuEventKey(unwrapped, inbound);
  const stopped = await feishuClaimStop(eventKey, input.gatewayDir);
  if (stopped) return stopped;

  const agentId = input.spec.defaultAgentId ?? 'main';
  const botId = input.settings.feishu.botId ?? input.spec.botId;
  const replyChannel = input.spec.replyChannelId
    ? input.channels.find((c) => c.id === input.spec.replyChannelId)
    : undefined;

  // Model text stays a draft. A person releases it through releaseOutboundDraft.
  const reply = async (text: string) => {
    if (!replyChannel) return;
    if (replyChannel.type === 'feishu_bot') {
      await portDraft(input.gatewayDir, {
        channelId: replyChannel.id,
        text,
        event: 'gateway.im.reply',
        receiveId: inbound.receiveId,
        receiveIdType: inbound.receiveIdType
      });
      return;
    }
    await deliverChannelText({
      gatewayDir: input.gatewayDir,
      channel: replyChannel,
      text,
      event: 'gateway.im.reply'
    });
  };

  scheduleGatewayTurn(botId ? `bot:${botId}` : inbound.sessionKey, async () => {
    const state = await readGatewayState(input.gatewayDir);
    await runAgentTurnAndReply({
      runtime: input.runtime,
      gatewayDir: input.gatewayDir,
      state,
      sessionKey: inbound.sessionKey,
      userText: inbound.text,
      agentId,
      botId,
      origin: 'human',
      reply
    });
  });

  return { kind: 'empty', status: 200 };
}

function wecomConfiguredSecret(settings: GatewaySettings, spec: WeComProviderSpec): string {
  return (settings.wecom.bridgeSecret ?? spec.bridgeSecret)?.trim() ?? '';
}

function wecomSecretRejected(input: {
  headers?: Record<string, string | string[] | undefined>;
  spec: WeComProviderSpec;
  settings: GatewaySettings;
}): { status: number; body: Record<string, unknown> } | undefined {
  const secret = wecomConfiguredSecret(input.settings, input.spec);
  if (!secret) return { status: 403, body: { error: 'WeCom bridge secret is not configured' } };
  if (!safeEqual(headerValue(input.headers, 'x-wecom-bridge-secret') ?? '', secret)) {
    return { status: 403, body: { error: 'Invalid secret' } };
  }
  return undefined;
}

function wecomTimestampRejected(headers: Record<string, string | string[] | undefined> | undefined): boolean {
  return !inboundTimestampFresh(headerValue(headers, 'x-wecom-bridge-timestamp') ?? '', Date.now());
}

function wecomEventKey(
  userKey: string,
  text: string,
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined> | undefined
): string {
  const msgId = String(body.msgId ?? body.msg_id ?? '').trim();
  if (msgId) return `wecom:msg:${msgId}`;
  const timestamp = headerValue(headers, 'x-wecom-bridge-timestamp') ?? '';
  const digest = createHash('sha256').update(`${userKey}\n${timestamp}\n${text}`).digest('hex');
  return `wecom:body:${digest}`;
}

export async function handleWeComBridgeRequest(input: {
  body: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  spec: WeComProviderSpec;
  settings: GatewaySettings;
  runtime: RawAgentRuntime;
  gatewayDir: string;
  channels: ChannelSpec[];
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const rejected = wecomSecretRejected(input);
  if (rejected) return rejected;
  if (wecomTimestampRejected(input.headers)) {
    return { status: 403, body: { error: 'Stale or missing timestamp' } };
  }

  const userKey = String(input.body.userKey ?? input.body.user_id ?? '').trim();
  const text = String(input.body.text ?? input.body.content ?? '').trim();
  if (!userKey || !text) {
    return { status: 400, body: { error: 'Missing userKey and text' } };
  }
  if (!isSenderAllowed(input.settings.wecom.allowedSenders, [userKey])) {
    return { status: 403, body: { error: 'sender_not_allowed' } };
  }
  const stopped = await wecomClaimStop(wecomEventKey(userKey, text, input.body, input.headers), input.gatewayDir);
  if (stopped) return stopped;

  const agentId = input.spec.defaultAgentId ?? 'main';
  const botId = input.settings.wecom.botId ?? input.spec.botId;
  const state = await readGatewayState(input.gatewayDir);
  const sessionKey = `wecom:user:${userKey}`;

  const replyChannel = input.spec.replyChannelId
    ? input.channels.find((c) => c.id === input.spec.replyChannelId)
    : undefined;

  // Model text stays a draft. A person releases it through releaseOutboundDraft.
  const reply = async (out: string) => {
    if (!replyChannel) return;
    await deliverChannelText({
      gatewayDir: input.gatewayDir,
      channel: replyChannel,
      text: out,
      event: 'gateway.im.reply'
    });
  };

  await runAgentTurnAndReply({
    runtime: input.runtime,
    gatewayDir: input.gatewayDir,
    state,
    sessionKey,
    userText: text,
    agentId,
    botId,
    origin: 'human',
    reply
  });

  return { status: 200, body: { ok: true } };
}
