import type { RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { composerHintHttpResult } from '../composer-hint.js';

export function composerHintRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'POST',
      pattern: '/api/lab/composer-hint',
      handler: async ({ response, readBody }) => {
        try {
          const result = await composerHintHttpResult(runtime, await readBody());
          json(response, result.status, result.body);
        } catch {
          if (!response.headersSent) json(response, 200, { hint: '' });
        }
      }
    }
  ];
}
