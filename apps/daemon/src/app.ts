import { factoryRoutes } from './routes/factory.js';
import { botRoomsRoutes } from './routes/bot-rooms.js';
import { botFunctionalGroupRoutes } from './routes/bot-functional-groups.js';
import { botWorkRoutes } from './routes/bot-work.js';
import { botGoalsRoutes } from './routes/bot-goals.js';
import { botHistoryRoutes } from './routes/bot-history.js';
import { computerUseRoutes } from './routes/computer-use.js';
import { appControlRoutes } from './routes/app-control.js';
import { connectorRoutes } from './routes/connectors.js';
/**
 * Daemon HTTP application: route registry + auth pipeline, without listening
 * or background timers, so tests can drive the real registry in-process.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGatewayHttp, type GatewayHandleContext } from '@ppeng/agent-capability-gateway';
import {
  oauthPublicConfig,
  ResourceOwnerStore,
  type AuthStore,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import { buildRoutePolicy } from './access/policy.js';
import { checkAuth, hasDaemonBearer } from './auth.js';
import { evolutionRoutes } from './evolution-api.js';
import { json } from './http-utils.js';
import { Router } from './routing.js';
import { attachmentRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { botsRoutes } from './routes/bots.js';
import { botMaterialRoutes } from './routes/bot-materials.js';
import { capabilitiesRoutes } from './routes/capabilities.js';
import { compactRoutes } from './routes/compact.js';
import { gatewaySettingsRoutes } from './routes/gateway-settings.js';
import { configRoutes, type ConfigRoutesDeps } from './routes/config.js';
import { cronRoutes } from './routes/cron.js';
import { dynToolRoutes } from './routes/dyn-tools.js';
import { goalRoutes } from './routes/goals.js';
import { jevRoutes } from './routes/jev.js';
import { langfuseRoutes } from './routes/langfuse.js';
import { loopRoutes } from './routes/loop.js';
import { mailboxRoutes } from './routes/mailbox.js';
import { mcpOAuthRoutes } from './routes/mcp-oauth.js';
import { memoryRoutes } from './routes/memory.js';
import { miscRoutes } from './routes/misc.js';
import { modelFallbackRoutes } from './routes/model-fallback.js';
import { modelProviderRoutes } from './routes/model-providers.js';
import { orchestrationRoutes } from './routes/orchestration.js';
import { outboundDraftRoutes } from './routes/outbound-drafts.js';
import { researchRoutes } from './routes/research.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { secretsRoutes } from './routes/secrets.js';
import { selfHealRoutes } from './routes/self-heal.js';
import { sessionsRoutes } from './routes/sessions.js';
import { skillEvalRoutes } from './routes/skill-eval.js';
import { skillProposalRoutes } from './routes/skill-proposals.js';
import { skillSettingsRoutes } from './routes/skill-settings.js';
import { socialRoutes } from './routes/social.js';
import { swarmRoutes } from './routes/swarm.js';
import { tasksRoutes } from './routes/tasks.js';
import { teamsDagRoutes } from './routes/teams-dag.js';
import { trajectoryRoutes } from './routes/trajectory.js';
import { workspaceRoutes } from './routes/workspace.js';
import { requireLabLogin, resolveRequestAuth } from './user-auth.js';
import { isExternalAgentTaskPath } from './external-agent-settings.js';
import { externalAgentRoutes } from './routes/external-agents.js';

export interface DaemonAppDeps {
  runtime: RawAgentRuntime;
  authStore: AuthStore;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  config: Omit<ConfigRoutesDeps, 'env' | 'repoRoot'>;
  pkgName: string;
  pkgVersion: string;
  readBody: (request: IncomingMessage) => Promise<unknown>;
  readBodyLimit: number;
  applyCors?: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => boolean;
  /** Current capability-gateway context (reloadable), if the gateway is enabled. */
  gateway?: () => GatewayHandleContext | undefined;
  /** Runs after authentication; return false once a response was written (rate limiting). */
  admit?: (request: IncomingMessage, response: ServerResponse<IncomingMessage>, url: URL) => boolean;
}

export function buildDaemonRouter(deps: DaemonAppDeps): Router {
  const { runtime, env, repoRoot } = deps;
  const policy = buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) });
  return new Router({ applyCors: deps.applyCors, readBody: deps.readBody, policy })
    .addAll(authRoutes({ runtime, authStore: deps.authStore, env }))
    .addAll(miscRoutes(runtime, { pkgName: deps.pkgName, pkgVersion: deps.pkgVersion }))
    .addAll(sessionsRoutes(runtime))
    .addAll(botsRoutes(runtime))
    .addAll(botMaterialRoutes(runtime))
    .addAll(botFunctionalGroupRoutes(runtime))
    .addAll(botWorkRoutes(runtime))
    .addAll(botGoalsRoutes(runtime))
    .addAll(botRoomsRoutes(runtime))
    .addAll(factoryRoutes(runtime))
    .addAll(botHistoryRoutes(runtime))
    .addAll(cronRoutes(runtime))
    .addAll(configRoutes(runtime, { ...deps.config, env, repoRoot }))
    .addAll(loopRoutes(runtime))
    .addAll(compactRoutes(runtime))
    .addAll(gatewaySettingsRoutes(runtime))
    .addAll(tasksRoutes(runtime))
    .addAll(externalAgentRoutes(runtime))
    .addAll(socialRoutes(runtime, repoRoot))
    .addAll(outboundDraftRoutes(runtime, repoRoot, env))
    .addAll(selfHealRoutes(runtime))
    .addAll(mailboxRoutes(runtime))
    .addAll(orchestrationRoutes(runtime))
    .addAll(researchRoutes(runtime))
    .addAll(memoryRoutes(runtime))
    .addAll(swarmRoutes(runtime))
    .addAll(goalRoutes(runtime))
    .addAll(jevRoutes(runtime))
    .addAll(langfuseRoutes(runtime))
    .addAll(teamsDagRoutes(runtime))
    .addAll(capabilitiesRoutes(runtime))
    .addAll(computerUseRoutes(runtime))
    .addAll(appControlRoutes(runtime))
    .addAll(connectorRoutes(runtime))
    .addAll(modelProviderRoutes(runtime))
    .addAll(modelFallbackRoutes(runtime))
    .addAll(secretsRoutes(runtime))
    .addAll(mcpOAuthRoutes(runtime))
    .addAll(skillEvalRoutes(runtime))
    .addAll(skillSettingsRoutes(runtime))
    .addAll(skillProposalRoutes(runtime))
    .addAll(dynToolRoutes(runtime))
    .addAll(attachmentRoutes(runtime))
    .addAll(sandboxRoutes(runtime))
    .addAll(trajectoryRoutes(runtime))
    .addAll(workspaceRoutes(runtime))
    .addAll(evolutionRoutes(repoRoot));
}

/**
 * Gateway paths without `RAW_AGENT_GATEWAY_TOKEN` fall back to the daemon bearer;
 * with neither configured they stay open only while Lab login is off.
 */
export function gatewayAuthorizer(env: NodeJS.ProcessEnv): (request: IncomingMessage) => boolean {
  return (request) => {
    if (String(env.RAW_AGENT_AUTH_TOKEN ?? '').trim()) return hasDaemonBearer(request, env);
    return !oauthPublicConfig(env).loginRequired;
  };
}

export interface DaemonApp {
  router: Router;
  /** Handles gateway and `/api/*` requests; returns false for anything else (static files). */
  handle(request: IncomingMessage, response: ServerResponse<IncomingMessage>): Promise<boolean>;
}

export function createDaemonApp(deps: DaemonAppDeps): DaemonApp {
  const router = buildDaemonRouter(deps);
  const authorize = gatewayAuthorizer(deps.env);

  const handleApi = async (request: IncomingMessage, response: ServerResponse<IncomingMessage>, url: URL) => {
    // Only these exact task paths use independent scoped credentials. Their handlers
    // require an external credential even when daemon auth / Lab login are disabled.
    if (isExternalAgentTaskPath(url.pathname)) {
      if (deps.admit && !deps.admit(request, response, url)) return;
      if (!(await router.dispatch(request, response, url))) json(response, 404, { error: 'Route not found' });
      return;
    }
    if (!checkAuth(request, response, deps.env)) return;
    const auth = resolveRequestAuth({
      request,
      env: deps.env,
      memory: deps.runtime.store.agentMemory(),
      authStore: deps.authStore
    });
    if (!requireLabLogin(request, response, deps.env, auth)) return;
    if (deps.admit && !deps.admit(request, response, url)) return;
    if (!(await router.dispatch(request, response, url, auth))) json(response, 404, { error: 'Route not found' });
  };

  return {
    router,
    async handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://daemon.local');
      const gateway = deps.gateway?.();
      if (gateway && (await handleGatewayHttp(request, response, { ...gateway, authorize }, deps.readBodyLimit))) {
        return true;
      }
      if (!url.pathname.startsWith('/api/')) return false;
      await handleApi(request, response, url);
      return true;
    }
  };
}
