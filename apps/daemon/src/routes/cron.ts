/**
 * Bot / session cron jobs.
 * GET/POST /api/cron/jobs, PATCH/DELETE /api/cron/jobs/:id
 * Persistence is stateDir/cron/jobs.json. Tick always runs (no RAW_AGENT_* switch).
 */

import { type RawAgentRuntime, type UpdateCronJobInput } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { visibleCronJobs } from '../access/visibility.js';

export function cronRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/cron/jobs',
      handler: ({ url, response, auth }) => {
        const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
        const botId = url.searchParams.get('botId')?.trim() || undefined;
        const enabledRaw = url.searchParams.get('enabled');
        const enabled =
          enabledRaw === '1' || enabledRaw === 'true'
            ? true
            : enabledRaw === '0' || enabledRaw === 'false'
              ? false
              : undefined;
        json(response, 200, { jobs: visibleCronJobs(runtime, runtime.listCronJobs({ sessionId, botId, enabled }), auth) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/cron/jobs',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const job = runtime.createCronJob({
          name: typeof body.name === 'string' ? body.name : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          cron: typeof body.cron === 'string' ? body.cron : '',
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          botId: typeof body.botId === 'string' ? body.botId : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          ...('precheck' in body ? { precheck: body.precheck } : {})
        });
        json(response, 201, { job });
      }
    },
    {
      method: 'GET',
      pattern: '/api/cron/jobs/:id',
      handler: ({ requireParam, response }) => {
        json(response, 200, { job: runtime.getCronJob(requireParam('id')) });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/cron/jobs/:id',
      handler: async ({ requireParam, readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const patch: UpdateCronJobInput = {};
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.prompt === 'string') patch.prompt = body.prompt;
        if (typeof body.cron === 'string') patch.cron = body.cron;
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if ('precheck' in body) patch.precheck = body.precheck;
        json(response, 200, { job: runtime.updateCronJob(requireParam('id'), patch) });
      }
    },
    {
      method: 'DELETE',
      pattern: '/api/cron/jobs/:id',
      handler: ({ requireParam, response }) => {
        runtime.deleteCronJob(requireParam('id'));
        json(response, 200, { ok: true });
      }
    }
  ];
}
