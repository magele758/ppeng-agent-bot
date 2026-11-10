import type { RawAgentRuntime } from '@ppeng/agent-core';
import type { MessageSearchDb } from '../message-search.js';
import { parseMessageSearchLimit, searchSessionMessageBodies } from '../message-search.js';
import { json } from '../http-utils.js';
import type { RouteSpec } from '../routing.js';
import { listedSessions } from '../session-guard.js';

/** Same access class as GET /api/sessions: self-filtered, then listedSessions. */
export function messageSearchRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/search/messages',
      handler: (ctx) => {
        json(ctx.response, 200, {
          hits: searchSessionMessageBodies(
            runtime.store.db as unknown as MessageSearchDb,
            listedSessions(runtime, ctx.auth),
            ctx.url.searchParams.get('q') ?? '',
            parseMessageSearchLimit(ctx.url.searchParams.get('limit'))
          )
        });
      }
    }
  ];
}
