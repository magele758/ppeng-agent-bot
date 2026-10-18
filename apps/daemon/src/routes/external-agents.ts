import type { RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { authenticateExternalAgent, publicExternalAgentSettings, readExternalAgentSettings, writeExternalAgentSettings } from '../external-agent-settings.js';
import { externalTaskView, submitExternalTask } from '../external-agent-tasks.js';

export function externalAgentRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
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
    { method: 'GET', pattern: '/api/external-agent/v1/tasks/:id', handler: ({ request, response, requireParam }) => {
      const client = authenticateExternalAgent(runtime, request);
      json(response, 200, { task: externalTaskView(runtime, client, requireParam('id')) });
    } }
  ];
}
