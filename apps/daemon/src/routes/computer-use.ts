import { readLcuSettings, writeLcuSettings, type RawAgentRuntime, ValidationError } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
export function computerUseRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    { method: 'GET', pattern: '/api/computer-use/settings', handler: ({response}) => json(response,200,{settings:readLcuSettings(runtime.store)}) },
    { method: 'PATCH', pattern: '/api/computer-use/settings', handler: async ({readBody,response}) => {
      const body = await readBody() as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['enabled','command'].includes(key))) throw new ValidationError('Only enabled and command may be changed');
      let settings;
      try { settings = writeLcuSettings(runtime.store,body); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : String(error)); }
      if (!settings.enabled) await runtime.computerUse.close();
      json(response,200,{settings});
    } },
  ];
}
