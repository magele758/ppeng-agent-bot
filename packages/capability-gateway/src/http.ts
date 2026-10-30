import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RawAgentRuntime } from '@ppeng/agent-core';
import { NotFoundError, parseGenericWebhookInbound, processChannelTurn } from '@ppeng/agent-core';
import { loadGatewayFileConfig, parseGatewayEnv } from './config.js';
import { maybeRunScheduledLearn, runLearnCycle } from './learn.js';
import {
  handleFeishuEventRequest,
  handleWeComBridgeRequest,
  runAgentTurnAndReply,
  tryBotChatCommand
} from './im-handlers.js';
import { handleEventIngress } from './event-ingress.js';
import { handleSlackEventsRequest } from './slack-events-handler.js';
import { appendOutboundDraft as appendOutboundDraftLedger } from './outbound-drafts.js';
import { createUserDeliveryPort } from './user-delivery-port.js';

/** Route user-facing drafts through UserDeliveryPort without touching handleGatewayHttp body. */
function appendOutboundDraft(
  gatewayDir: string,
  input: {
    channelId: string;
    text: string;
    event?: string;
    receiveId?: string;
    receiveIdType?: import('./outbound-drafts.js').FeishuReceiveIdType;
  }
) {
  void appendOutboundDraftLedger;
  return createUserDeliveryPort({ gatewayDir, channels: [] }).draft(input);
}

import { quarantineLegacyDraftLedger, reconcileSendingDrafts, recoverGatewayOutbound } from './outbound.js';
import { resolveImOutbound } from './silent-reply.js';
import { readGatewaySettings } from './gateway-settings.js';
import { safeEqual } from './inbound-guard.js';
import { readGatewayState } from './state.js';
import type { GatewayEnvOptions, GatewayFileConfig } from './types.js';

export interface GatewayHandleContext {
  runtime: RawAgentRuntime;
  repoRoot: string;
  stateDir: string;
  env: GatewayEnvOptions;
  /** Mutable; reload-config updates this ref */
  fileConfigRef: { current: GatewayFileConfig };
  /**
   * Host check for non-platform paths when `RAW_AGENT_GATEWAY_TOKEN` is unset
   * (the daemon falls back to its own bearer token). Absent = open.
   */
  authorize?: (request: IncomingMessage) => boolean;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return (await readRawJsonBody(request, limit)).parsed;
}

/** Body as received (needed for signature checks) plus its parsed JSON. */
async function readRawJsonBody(
  request: IncomingMessage,
  limit: number
): Promise<{ raw: string; parsed: unknown }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return { raw: '', parsed: {} };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { raw: text, parsed: JSON.parse(text) as unknown };
  } catch {
    throw new SyntaxError('Invalid JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

async function dispatchSlackEvents(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: GatewayHandleContext,
  fc: GatewayFileConfig,
  gatewayDir: string,
  readBodyLimit: number
): Promise<boolean> {
  const spec = fc.providers?.slack;
  if (!spec?.enabled) {
    json(response, 404, { error: 'Slack provider disabled' });
    return true;
  }
  const { raw, parsed } = await readRawJsonBody(request, readBodyLimit);
  const out = await handleSlackEventsRequest({
    body: parsed,
    rawBody: raw,
    headers: request.headers,
    spec,
    settings: readGatewaySettings(ctx.runtime.store),
    runtime: ctx.runtime,
    gatewayDir,
    stateDir: gatewayDir,
    channels: fc.channels ?? []
  });
  if (out.kind === 'challenge') {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ challenge: out.challenge }));
    return true;
  }
  if (out.kind === 'json') {
    json(response, out.status, out.body);
    return true;
  }
  response.statusCode = out.status;
  response.end();
  return true;
}

function checkAuth(request: IncomingMessage, ctx: GatewayHandleContext): boolean {
  const token = ctx.env.authToken;
  if (!token) {
    return ctx.authorize ? ctx.authorize(request) : true;
  }
  const h = request.headers['x-gateway-token'];
  if (typeof h === 'string' && safeEqual(h, token)) {
    return true;
  }
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return safeEqual(auth.slice(7), token);
  }
  return false;
}

function gatewayPathParts(pathname: string, prefix: string): string[] | null {
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (!pathname.startsWith(p)) {
    return null;
  }
  const rest = pathname.slice(p.length);
  if (rest !== '' && rest !== '/' && !rest.startsWith('/')) {
    return null;
  }
  const tail = rest.replace(/^\//, '') || '';
  return tail ? tail.split('/').filter(Boolean) : [];
}

interface GatewayRoute {
  request: IncomingMessage;
  response: ServerResponse;
  ctx: GatewayHandleContext;
  fc: GatewayFileConfig;
  gatewayDir: string;
  parts: string[];
  readBodyLimit: number;
}

const PLATFORM_ACTION: Record<string, string> = { feishu: 'events', wecom: 'bridge', slack: 'events' };
const EVENT_INGRESS = new Set(['github', 'slack', 'email', 'webhook', 'ci']);

function isPlatformPath(parts: string[]): boolean {
  const action = parts[0] === 'providers' ? PLATFORM_ACTION[parts[1] ?? ''] : undefined;
  return action !== undefined && parts[2] === action;
}

function isEventIngressPath(method: string | undefined, parts: string[]): boolean {
  return method === 'POST' && parts[0] === 'routines' && EVENT_INGRESS.has(parts[1] ?? '') && parts.length === 2;
}

type ProviderHttpResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number };

function writeProviderResult(response: ServerResponse, out: ProviderHttpResult): void {
  if (out.kind === 'challenge') {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ challenge: out.challenge }));
    return;
  }
  if (out.kind === 'json') {
    json(response, out.status, out.body);
    return;
  }
  response.statusCode = out.status;
  response.end();
}

async function dispatchFeishuEvents(route: GatewayRoute): Promise<void> {
  const spec = route.fc.providers?.feishu;
  if (!spec?.enabled) {
    json(route.response, 404, { error: 'Feishu provider disabled' });
    return;
  }
  const { raw, parsed } = await readRawJsonBody(route.request, route.readBodyLimit);
  const out = await handleFeishuEventRequest({
    body: (parsed ?? {}) as Record<string, unknown>,
    rawBody: raw,
    headers: route.request.headers,
    spec,
    settings: readGatewaySettings(route.ctx.runtime.store),
    runtime: route.ctx.runtime,
    gatewayDir: route.gatewayDir,
    channels: route.fc.channels ?? []
  });
  writeProviderResult(route.response, out);
}

async function dispatchWeComBridge(route: GatewayRoute): Promise<void> {
  const spec = route.fc.providers?.wecom;
  if (!spec?.enabled) {
    json(route.response, 404, { error: 'WeCom provider disabled' });
    return;
  }
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const out = await handleWeComBridgeRequest({
    body,
    headers: route.request.headers,
    spec,
    settings: readGatewaySettings(route.ctx.runtime.store),
    runtime: route.ctx.runtime,
    gatewayDir: route.gatewayDir,
    channels: route.fc.channels ?? []
  });
  json(route.response, out.status, out.body);
}

async function dispatchAgentInvoke(route: GatewayRoute): Promise<void> {
  const agentId = route.parts[1] ?? '';
  const routeSpec = (route.fc.agentRoutes ?? []).find((item) => item.agentId === agentId);
  if (!routeSpec) {
    json(route.response, 404, { error: 'Unknown agent route' });
    return;
  }
  if (routeSpec.routeKey) {
    const got = route.request.headers['x-agent-route-key'];
    if (typeof got !== 'string' || !safeEqual(got, routeSpec.routeKey)) {
      json(route.response, 401, { error: 'Invalid X-Agent-Route-Key' });
      return;
    }
  }
  if (!route.ctx.runtime.listAgents().some((agent) => agent.id === agentId)) {
    json(route.response, 404, { error: 'Agent not registered' });
    return;
  }
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const message = String(body.message ?? '').trim();
  if (!message) {
    json(route.response, 400, { error: 'Missing message' });
    return;
  }
  const userKey = String(body.userKey ?? 'default').trim() || 'default';
  const state = await readGatewayState(route.gatewayDir);
  const { sessionId } = await runAgentTurnAndReply({
    runtime: route.ctx.runtime,
    gatewayDir: route.gatewayDir,
    state,
    sessionKey: `invoke:${agentId}:${userKey}`,
    userText: message,
    agentId,
    stickySession: body.stickySession !== false && routeSpec.stickySession !== false,
    reply: async () => {
      /* internal invoke: HTTP response carries assistant text */
    }
  });
  json(route.response, 200, {
    agentId,
    sessionId,
    latestAssistant: route.ctx.runtime.getLatestAssistantText(sessionId)
  });
}

async function openChatBotSession(
  route: GatewayRoute,
  botId: string
): Promise<string | undefined> {
  try {
    return route.ctx.runtime.openBot(botId).sessionId;
  } catch (error) {
    if (error instanceof NotFoundError || (error as { statusCode?: number }).statusCode === 404) {
      json(route.response, 404, { error: `Unknown bot: ${botId}` });
      return undefined;
    }
    throw error;
  }
}

async function dispatchChat(route: GatewayRoute): Promise<boolean> {
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const message = String(body.message ?? '').trim();
  if (!message) {
    json(route.response, 400, { error: 'Missing message' });
    return true;
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const botId = typeof body.botId === 'string' ? body.botId.trim() : '';
  const botSessionId = botId && !sessionId ? await openChatBotSession(route, botId) : undefined;
  if (botId && !sessionId && !botSessionId) return true;
  if (botSessionId) {
    const command = await tryBotChatCommand(route.ctx.runtime, botSessionId, message);
    if (command) {
      json(route.response, 200, {
        command,
        session: route.ctx.runtime.getSession(botSessionId),
        latestAssistant: command.reply
      });
      return true;
    }
  }
  const session = chatSessionFor(route, body, message, botSessionId, sessionId);
  await route.ctx.runtime.runSession(session.id);
  json(route.response, 200, {
    session: route.ctx.runtime.getSession(session.id),
    latestAssistant: route.ctx.runtime.getLatestAssistantText(session.id)
  });
  return true;
}

function chatSessionFor(
  route: GatewayRoute,
  body: Record<string, unknown>,
  message: string,
  botSessionId: string | undefined,
  sessionId: string | undefined
) {
  if (botSessionId) return route.ctx.runtime.sendUserMessage(botSessionId, message);
  if (sessionId) return route.ctx.runtime.sendUserMessage(sessionId, message);
  return route.ctx.runtime.createChatSession({
    title: typeof body.title === 'string' ? body.title : 'Gateway Chat',
    message,
    agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    background: false
  });
}

const DRAFT_CHANNEL_TYPES = new Set(['webhook', 'http_post', 'slack', 'telegram', 'email']);

async function runChannelWebhookTurn(
  route: GatewayRoute,
  channel: NonNullable<GatewayFileConfig['channels']>[number],
  inbound: NonNullable<ReturnType<typeof parseGenericWebhookInbound>>,
  body: Record<string, unknown>
) {
  const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : 'general';
  const state = await readGatewayState(route.gatewayDir);
  const webhookAllowed = readGatewaySettings(route.ctx.runtime.store).webhook.allowedSenders;
  const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : undefined;
  return processChannelTurn(inbound, {
    defaultAgentId: agentId,
    allowedSenders: webhookAllowed.length > 0 ? new Set(webhookAllowed) : undefined,
    runAgentTurn: async ({ conversationKey, text, agentId: aid }) => {
      const { sessionId } = await runAgentTurnAndReply({
        runtime: route.ctx.runtime,
        gatewayDir: route.gatewayDir,
        state,
        sessionKey: `${channel.type}:${conversationKey}`,
        userText: text,
        agentId: aid,
        stickySession: true,
        botId,
        origin: 'webhook',
        reply: async () => {
          /* outbound handled below when channel supports delivery */
        }
      });
      return {
        sessionId,
        assistantText: route.ctx.runtime.getLatestAssistantText(sessionId) ?? ''
      };
    }
  });
}

async function dispatchChannelWebhook(route: GatewayRoute): Promise<void> {
  const channelId = route.parts[1] ?? '';
  const channel = (route.fc.channels ?? []).find((item) => item.id === channelId);
  if (!channel) {
    json(route.response, 404, { error: 'Unknown channel' });
    return;
  }
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const inbound = parseGenericWebhookInbound(channelId, channel.type, body);
  if (!inbound) {
    json(route.response, 400, { error: 'Unrecognized webhook payload' });
    return;
  }
  const result = await runChannelWebhookTurn(route, channel, inbound, body);
  if (result.error) {
    json(route.response, result.error === 'empty_message' ? 400 : 403, { error: result.error });
    return;
  }
  const decision = resolveImOutbound(result.reply?.text ?? '', { origin: 'webhook', userText: inbound.text });
  if (decision.action === 'drop') {
    json(route.response, 200, { ok: true, sessionId: result.sessionId, reply: null });
    return;
  }
  if (DRAFT_CHANNEL_TYPES.has(channel.type)) {
    try {
      await appendOutboundDraft(route.gatewayDir, {
        channelId: channel.id,
        text: decision.text,
        event: 'gateway.im.reply'
      });
    } catch (error) {
      json(route.response, 502, {
        error: error instanceof Error ? error.message : String(error),
        sessionId: result.sessionId,
        reply: result.reply
      });
      return;
    }
  }
  json(route.response, 200, {
    ok: true,
    sessionId: result.sessionId,
    reply: result.reply ? { ...result.reply, text: decision.text } : result.reply
  });
}

async function dispatchTask(route: GatewayRoute): Promise<void> {
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const title = String(body.title ?? '').trim();
  if (!title) {
    json(route.response, 400, { error: 'Missing title' });
    return;
  }
  const result = route.ctx.runtime.createTaskSession({
    title,
    description: typeof body.description === 'string' ? body.description : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : undefined,
    background: body.background !== false
  });
  if (body.autoRun !== false) {
    await route.ctx.runtime.runSession(result.session.id);
  }
  json(route.response, 201, {
    task: route.ctx.runtime.getTask(result.task.id),
    session: route.ctx.runtime.getSession(result.session.id),
    latestAssistant: route.ctx.runtime.getLatestAssistantText(result.session.id)
  });
}

async function dispatchMailbox(route: GatewayRoute): Promise<void> {
  const body = (await readJsonBody(route.request, route.readBodyLimit)) as Record<string, unknown>;
  const fromAgentId = String(body.fromAgentId ?? '').trim();
  const toAgentId = String(body.toAgentId ?? '').trim();
  const content = String(body.content ?? '').trim();
  if (!fromAgentId || !toAgentId || !content) {
    json(route.response, 400, { error: 'Missing fromAgentId, toAgentId, or content' });
    return;
  }
  const mail = route.ctx.runtime.sendMailboxMessage({
    fromAgentId,
    toAgentId,
    content,
    type: typeof body.type === 'string' ? body.type : undefined,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined
  });
  json(route.response, 201, { mail });
}

async function dispatchLearnRun(route: GatewayRoute): Promise<void> {
  const learn = route.ctx.fileConfigRef.current.learn;
  if (!learn?.feeds?.length) {
    json(route.response, 400, { error: 'Configure learn.feeds in gateway.config.json' });
    return;
  }
  const result = await runLearnCycle({
    repoRoot: route.ctx.repoRoot,
    gatewayStateDir: route.gatewayDir,
    runtime: route.ctx.runtime,
    learn,
    channels: route.fc.channels ?? []
  });
  json(route.response, result.ok ? 200 : 502, result);
}

async function dispatchSkillsDigest(route: GatewayRoute): Promise<void> {
  const state = await readGatewayState(route.gatewayDir);
  json(route.response, 200, {
    markdown: state.lastDigestMarkdown ?? '',
    lastRun: state.lastLearnRunDateUtc ?? null
  });
}

async function dispatchReloadConfig(route: GatewayRoute): Promise<void> {
  route.ctx.fileConfigRef.current = (await loadGatewayFileConfig(route.ctx.env.configPath!)) ?? {};
  json(route.response, 200, { ok: true });
}

/** `*` means that path segment must be non-empty; extra segments are ignored. */
const ROUTE_PATTERNS: Array<[method: string, pattern: string[], key: string]> = [
  ['POST', ['providers', 'feishu', 'events'], 'feishu'],
  ['POST', ['providers', 'wecom', 'bridge'], 'wecom'],
  ['POST', ['agents', '*', 'invoke'], 'invoke'],
  ['GET', ['health'], 'health'],
  ['GET', ['agents'], 'agents'],
  ['POST', ['chat'], 'chat'],
  ['POST', ['channels', '*', 'webhook'], 'channel-webhook'],
  ['POST', ['task'], 'task'],
  ['POST', ['mailbox'], 'mailbox'],
  ['POST', ['scheduler', 'run'], 'scheduler'],
  ['GET', ['skills', 'digest'], 'digest'],
  ['POST', ['learn', 'run'], 'learn'],
  ['POST', ['admin', 'reload-config'], 'reload']
];

function patternMatches(parts: string[], pattern: string[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    const want = pattern[i];
    if (want === '*') {
      if (!parts[i]) return false;
    } else if (parts[i] !== want) return false;
  }
  return true;
}

function routeKey(method: string | undefined, parts: string[]): string {
  for (const [expected, pattern, key] of ROUTE_PATTERNS) {
    if (method === expected && patternMatches(parts, pattern)) return key;
  }
  return '';
}

async function dispatchGatewayRoute(route: GatewayRoute): Promise<boolean> {
  switch (routeKey(route.request.method, route.parts)) {
    case 'feishu':
      await dispatchFeishuEvents(route);
      return true;
    case 'wecom':
      await dispatchWeComBridge(route);
      return true;
    case 'invoke':
      await dispatchAgentInvoke(route);
      return true;
    case 'health':
      json(route.response, 200, { ok: true, gateway: true, prefix: route.ctx.env.pathPrefix });
      return true;
    case 'agents':
      json(route.response, 200, { agents: route.ctx.runtime.listAgents() });
      return true;
    case 'chat':
      return dispatchChat(route);
    case 'channel-webhook':
      await dispatchChannelWebhook(route);
      return true;
    case 'task':
      await dispatchTask(route);
      return true;
    case 'mailbox':
      await dispatchMailbox(route);
      return true;
    case 'scheduler':
      await route.ctx.runtime.runScheduler();
      json(route.response, 200, { ok: true });
      return true;
    case 'digest':
      await dispatchSkillsDigest(route);
      return true;
    case 'learn':
      await dispatchLearnRun(route);
      return true;
    case 'reload':
      await dispatchReloadConfig(route);
      return true;
    default:
      return false;
  }
}

export async function handleGatewayHttp(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: GatewayHandleContext,
  readBodyLimit = 2_000_000
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://local');
  const parts = gatewayPathParts(url.pathname, ctx.env.pathPrefix);
  if (parts === null) {
    return false;
  }

  const gatewayDir = `${ctx.stateDir}/gateway`;
  const fc = ctx.fileConfigRef.current;
  if (!isPlatformPath(parts) && !isEventIngressPath(request.method, parts) && !checkAuth(request, ctx)) {
    json(response, 401, { error: 'Unauthorized' });
    return true;
  }

  try {
    if (parts[0] === 'providers' && parts[1] === 'slack' && parts[2] === 'events') {
      return dispatchSlackEvents(request, response, ctx, fc, gatewayDir, readBodyLimit);
    }
    if (await handleEventIngress(request, response, ctx, parts, readBodyLimit)) {
      return true;
    }
    if (await dispatchGatewayRoute({ request, response, ctx, fc, gatewayDir, parts, readBodyLimit })) {
      return true;
    }
  } catch (error) {
    const code = error instanceof Error && (error as { code?: string }).code === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
    json(response, code, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  json(response, 404, { error: 'Not found' });
  return true;
}

const TICK_MS = 60_000;

export function startGatewayLearnTicker(
  getCtx: () => GatewayHandleContext | null,
  onError?: (e: unknown) => void
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const ctx = getCtx();
    const fc = ctx?.fileConfigRef.current;
    if (!ctx?.env.learnEnabled || !fc?.learn?.feeds?.length) {
      return;
    }
    void maybeRunScheduledLearn({
      repoRoot: ctx.repoRoot,
      gatewayStateDir: `${ctx.stateDir}/gateway`,
      runtime: ctx.runtime,
      learn: fc.learn,
      channels: fc.channels ?? [],
      hourUtc: ctx.env.learnDailyHourUtc
    }).catch((e) => onError?.(e));
  }, TICK_MS);
}

export async function createGatewayContext(
  runtime: RawAgentRuntime,
  repoRoot: string,
  stateDir: string
): Promise<GatewayHandleContext | null> {
  const env = parseGatewayEnv(repoRoot);
  const gatewayDir = `${stateDir}/gateway`;
  if (!env.enabled) {
    // Drafts are held even when the gateway listener is off. Unstick `sending`
    // left by a crash without replaying the ledger (that send path stays gated
    // on the listener being enabled).
    await reconcileSendingDrafts(gatewayDir);
    await quarantineLegacyDraftLedger(gatewayDir);
    return null;
  }
  const fileConfig = (await loadGatewayFileConfig(env.configPath!)) ?? {};
  await recoverGatewayOutbound({
    gatewayDir,
    channels: fileConfig.channels ?? []
  });
  return { runtime, repoRoot, stateDir, env, fileConfigRef: { current: fileConfig } };
}
