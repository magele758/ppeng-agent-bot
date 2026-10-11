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
import { deliverChannelText, recoverGatewayOutbound } from './outbound.js';
import { resolveImOutbound } from './silent-reply.js';
import { readGatewaySettings } from './gateway-settings.js';
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

function checkAuth(request: IncomingMessage, ctx: GatewayHandleContext): boolean {
  const token = ctx.env.authToken;
  if (!token) {
    return ctx.authorize ? ctx.authorize(request) : true;
  }
  const h = request.headers['x-gateway-token'];
  if (typeof h === 'string' && h === token) {
    return true;
  }
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7) === token;
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
  const isPlatformPath =
    (parts[0] === 'providers' && parts[1] === 'feishu' && parts[2] === 'events') ||
    (parts[0] === 'providers' && parts[1] === 'wecom' && parts[2] === 'bridge');

  if (!isPlatformPath && !checkAuth(request, ctx)) {
    json(response, 401, { error: 'Unauthorized' });
    return true;
  }

  try {
    if (request.method === 'POST' && parts[0] === 'providers' && parts[1] === 'feishu' && parts[2] === 'events') {
      const spec = fc.providers?.feishu;
      if (!spec?.enabled) {
        json(response, 404, { error: 'Feishu provider disabled' });
        return true;
      }
      const { raw, parsed } = await readRawJsonBody(request, readBodyLimit);
      const out = await handleFeishuEventRequest({
        body: (parsed ?? {}) as Record<string, unknown>,
        rawBody: raw,
        headers: request.headers,
        spec,
        settings: readGatewaySettings(ctx.runtime.store),
        runtime: ctx.runtime,
        gatewayDir,
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

    if (request.method === 'POST' && parts[0] === 'providers' && parts[1] === 'wecom' && parts[2] === 'bridge') {
      const spec = fc.providers?.wecom;
      if (!spec?.enabled) {
        json(response, 404, { error: 'WeCom provider disabled' });
        return true;
      }
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const out = await handleWeComBridgeRequest({
        body,
        headers: request.headers,
        spec,
        settings: readGatewaySettings(ctx.runtime.store),
        runtime: ctx.runtime,
        gatewayDir,
        channels: fc.channels ?? []
      });
      json(response, out.status, out.body);
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'agents' && parts[2] === 'invoke' && parts[1]) {
      const agentId = parts[1];
      const routes = fc.agentRoutes ?? [];
      const route = routes.find((r) => r.agentId === agentId);
      if (!route) {
        json(response, 404, { error: 'Unknown agent route' });
        return true;
      }
      if (route.routeKey) {
        const got = request.headers['x-agent-route-key'];
        if (typeof got !== 'string' || got !== route.routeKey) {
          json(response, 401, { error: 'Invalid X-Agent-Route-Key' });
          return true;
        }
      }
      if (!ctx.runtime.listAgents().some((a) => a.id === agentId)) {
        json(response, 404, { error: 'Agent not registered' });
        return true;
      }
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const message = String(body.message ?? '').trim();
      if (!message) {
        json(response, 400, { error: 'Missing message' });
        return true;
      }
      const userKey = String(body.userKey ?? 'default').trim() || 'default';
      const state = await readGatewayState(gatewayDir);
      const sticky = body.stickySession !== false && route.stickySession !== false;
      const { sessionId } = await runAgentTurnAndReply({
        runtime: ctx.runtime,
        gatewayDir,
        state,
        sessionKey: `invoke:${agentId}:${userKey}`,
        userText: message,
        agentId,
        stickySession: sticky,
        reply: async () => {
          /* internal invoke: HTTP response carries assistant text */
        }
      });
      json(response, 200, {
        agentId,
        sessionId,
        latestAssistant: ctx.runtime.getLatestAssistantText(sessionId)
      });
      return true;
    }

    if (request.method === 'GET' && parts[0] === 'health') {
      json(response, 200, { ok: true, gateway: true, prefix: ctx.env.pathPrefix });
      return true;
    }

    if (request.method === 'GET' && parts[0] === 'agents') {
      json(response, 200, { agents: ctx.runtime.listAgents() });
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'chat') {
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const message = String(body.message ?? '').trim();
      if (!message) {
        json(response, 400, { error: 'Missing message' });
        return true;
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
      const botId = typeof body.botId === 'string' ? body.botId.trim() : '';
      let botSessionId: string | undefined;
      if (botId && !sessionId) {
        try {
          botSessionId = ctx.runtime.openBot(botId).sessionId;
        } catch (e) {
          if (e instanceof NotFoundError || (e as { statusCode?: number }).statusCode === 404) {
            json(response, 404, { error: `Unknown bot: ${botId}` });
            return true;
          }
          throw e;
        }
      }
      if (botSessionId) {
        const command = await tryBotChatCommand(ctx.runtime, botSessionId, message);
        if (command) {
          json(response, 200, {
            command,
            session: ctx.runtime.getSession(botSessionId),
            latestAssistant: command.reply
          });
          return true;
        }
      }
      const session = botSessionId
        ? ctx.runtime.sendUserMessage(botSessionId, message)
        : sessionId
        ? ctx.runtime.sendUserMessage(sessionId, message)
        : ctx.runtime.createChatSession({
            title: typeof body.title === 'string' ? body.title : 'Gateway Chat',
            message,
            agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
            background: false
          });
      await ctx.runtime.runSession(session.id);
      json(response, 200, {
        session: ctx.runtime.getSession(session.id),
        latestAssistant: ctx.runtime.getLatestAssistantText(session.id)
      });
      return true;
    }

    // Generic / Telegram-ish inbound via channel turn kernel
    if (
      request.method === 'POST' &&
      parts[0] === 'channels' &&
      parts[2] === 'webhook' &&
      parts[1]
    ) {
      const channelId = parts[1];
      const channel = (fc.channels ?? []).find((c) => c.id === channelId);
      if (!channel) {
        json(response, 404, { error: 'Unknown channel' });
        return true;
      }
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const inbound = parseGenericWebhookInbound(channelId, channel.type, body);
      if (!inbound) {
        json(response, 400, { error: 'Unrecognized webhook payload' });
        return true;
      }
      const agentId =
        typeof body.agentId === 'string' && body.agentId.trim()
          ? body.agentId.trim()
          : 'general';
      const state = await readGatewayState(gatewayDir);
      const webhookAllowed = readGatewaySettings(ctx.runtime.store).webhook.allowedSenders;
      const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : undefined;
      const result = await processChannelTurn(inbound, {
        defaultAgentId: agentId,
        allowedSenders: webhookAllowed.length > 0 ? new Set(webhookAllowed) : undefined,
        runAgentTurn: async ({ conversationKey, text, agentId: aid }) => {
          const { sessionId } = await runAgentTurnAndReply({
            runtime: ctx.runtime,
            gatewayDir,
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
            assistantText: ctx.runtime.getLatestAssistantText(sessionId) ?? ''
          };
        }
      });
      if (result.error) {
        json(response, result.error === 'empty_message' ? 400 : 403, { error: result.error });
        return true;
      }
      const decision = resolveImOutbound(result.reply?.text ?? '', { origin: 'webhook', userText: inbound.text });
      if (decision.action === 'drop') {
        json(response, 200, { ok: true, sessionId: result.sessionId, reply: null });
        return true;
      }
      if (channel.type === 'webhook' || channel.type === 'http_post') {
        try {
          await deliverChannelText({ gatewayDir, channel, text: decision.text });
        } catch (e) {
          json(response, 502, {
            error: e instanceof Error ? e.message : String(e),
            sessionId: result.sessionId,
            reply: result.reply
          });
          return true;
        }
      }
      json(response, 200, {
        ok: true,
        sessionId: result.sessionId,
        reply: result.reply ? { ...result.reply, text: decision.text } : result.reply
      });
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'task') {
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const title = String(body.title ?? '').trim();
      if (!title) {
        json(response, 400, { error: 'Missing title' });
        return true;
      }
      const result = ctx.runtime.createTaskSession({
        title,
        description: typeof body.description === 'string' ? body.description : undefined,
        message: typeof body.message === 'string' ? body.message : undefined,
        agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
        blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : undefined,
        background: body.background !== false
      });
      if (body.autoRun !== false) {
        await ctx.runtime.runSession(result.session.id);
      }
      json(response, 201, {
        task: ctx.runtime.getTask(result.task.id),
        session: ctx.runtime.getSession(result.session.id),
        latestAssistant: ctx.runtime.getLatestAssistantText(result.session.id)
      });
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'mailbox') {
      const body = (await readJsonBody(request, readBodyLimit)) as Record<string, unknown>;
      const fromAgentId = String(body.fromAgentId ?? '').trim();
      const toAgentId = String(body.toAgentId ?? '').trim();
      const content = String(body.content ?? '').trim();
      if (!fromAgentId || !toAgentId || !content) {
        json(response, 400, { error: 'Missing fromAgentId, toAgentId, or content' });
        return true;
      }
      const mail = ctx.runtime.sendMailboxMessage({
        fromAgentId,
        toAgentId,
        content,
        type: typeof body.type === 'string' ? body.type : undefined,
        correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined
      });
      json(response, 201, { mail });
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'scheduler' && parts[1] === 'run') {
      await ctx.runtime.runScheduler();
      json(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'GET' && parts[0] === 'skills' && parts[1] === 'digest') {
      const state = await readGatewayState(gatewayDir);
      json(response, 200, {
        markdown: state.lastDigestMarkdown ?? '',
        lastRun: state.lastLearnRunDateUtc ?? null
      });
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'learn' && parts[1] === 'run') {
      const fc = ctx.fileConfigRef.current;
      const learn = fc.learn;
      if (!learn?.feeds?.length) {
        json(response, 400, { error: 'Configure learn.feeds in gateway.config.json' });
        return true;
      }
      const result = await runLearnCycle({
        repoRoot: ctx.repoRoot,
        gatewayStateDir: gatewayDir,
        runtime: ctx.runtime,
        learn,
        channels: fc.channels ?? []
      });
      json(response, result.ok ? 200 : 502, result);
      return true;
    }

    if (request.method === 'POST' && parts[0] === 'admin' && parts[1] === 'reload-config') {
      const next = (await loadGatewayFileConfig(ctx.env.configPath!)) ?? {};
      ctx.fileConfigRef.current = next;
      json(response, 200, { ok: true });
      return true;
    }
  } catch (e) {
    const code = e instanceof Error && (e as { code?: string }).code === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
    json(response, code, { error: e instanceof Error ? e.message : String(e) });
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
  if (!env.enabled) {
    return null;
  }
  const fileConfig = (await loadGatewayFileConfig(env.configPath!)) ?? {};
  await recoverGatewayOutbound({
    gatewayDir: `${stateDir}/gateway`,
    channels: fileConfig.channels ?? []
  });
  return { runtime, repoRoot, stateDir, env, fileConfigRef: { current: fileConfig } };
}
