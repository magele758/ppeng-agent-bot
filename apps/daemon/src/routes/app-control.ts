import { readAppControlSettings, writeAppControlSettings, type RawAgentRuntime, ValidationError } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function appControlRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/app-control/settings',
      handler: ({ response }) => json(response, 200, { settings: readAppControlSettings(runtime.store) })
    },
    {
      method: 'PATCH',
      pattern: '/api/app-control/settings',
      handler: async ({ readBody, response }) => {
        const body = await readBody() as Record<string, unknown>;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'enabled')) {
          throw new ValidationError('Only enabled may be changed');
        }
        let settings;
        try {
          settings = writeAppControlSettings(runtime.store, body);
        } catch (error) {
          throw new ValidationError(error instanceof Error ? error.message : String(error));
        }
        json(response, 200, { settings });
      }
    }
  ];
}
