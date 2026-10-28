import { resolveBotPrincipal, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { authenticateExternalAgent, publicExternalAgentSettings, readExternalAgentSettings, writeExternalAgentSettings } from '../external-agent-settings.js';
import { externalTaskAction, externalTaskView, submitExternalTask } from '../external-agent-tasks.js';

export function externalAgentRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {method: 'GET', pattern: '/api/external-agents/connections', handler: ({response}) => { json(response, 200, {settings: runtime.externalAgents.settings()}); }},
    {method: 'PATCH', pattern: '/api/external-agents/connections', handler: async ({response, readBody, auth}) => {
      const principal = resolveBotPrincipal(runtime.store, auth.user ? {userId: auth.user.id, tenantId: auth.user.tenantId} : undefined);
      json(response, 200, {settings: runtime.externalAgents.configure(await readBody(), principal)});
    }},
    { method: 'GET', pattern: '/api/external-agents/settings', handler: ({ response }) => {
      json(response, 200, { settings: publicExternalAgentSettings(readExternalAgentSettings(runtime)) });
    } },
    { method: 'PATCH', pattern: '/api/external-agents/settings', handler: async ({ response, readBody, auth }) => {
      json(response, 200, { settings: writeExternalAgentSettings(runtime, await readBody(), auth) });
    } },
    { method: 'POST', pattern: '/api/external-agent/v1/tasks', handler: async ({ request, response, readBody }) => {
      const client = authenticateExternalAgent(runtime, request);
      const result = submitExternalTask(runtime, client, await readBody());
      // Next middleware requires an absolute Location URL. A relative statusUrl
      // works through both a reverse proxy and direct daemon access.
      json(response, result.duplicate ? 200 : 202, { ...result, statusUrl: `/api/external-agent/v1/tasks/${result.task.id}` });
    } },
    ...(['cancel', 'input'] as const).map(action => ({method: 'POST' as const, pattern: `/api/external-agent/v1/tasks/:id/${action}`, handler: async ({request, response, requireParam, readBody}: Parameters<RouteSpec['handler']>[0]) => {
      const client = authenticateExternalAgent(runtime, request);
      json(response, 200, {task: externalTaskAction(runtime, client, requireParam('id'), action, await readBody())});
    }})),
    { method: 'GET', pattern: '/api/external-agent/v1/tasks/:id', handler: ({ request, response, requireParam }) => {
      const client = authenticateExternalAgent(runtime, request);
      json(response, 200, { task: externalTaskView(runtime, client, requireParam('id')) });
    } }
  ];
}
