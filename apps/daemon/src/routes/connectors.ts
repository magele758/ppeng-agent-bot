/**
 * Per-connector grants. Responses carry names and granted flags only.
 */

import { type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function connectorRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/connectors',
      handler: ({ response }) => {
        json(response, 200, { connectors: runtime.connectors.listPublic(process.env) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/connectors/:id/grant',
      handler: async ({ requireParam, readBody, response }) => {
        const id = requireParam('id');
        const record = runtime.connectors.grantConnector(id, await readBody(), process.env);
        json(response, 200, { connector: runtime.connectors.toPublic(record, process.env) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/connectors/:id/revoke',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        const record = runtime.connectors.revokeConnector(id, process.env);
        json(response, 200, { connector: runtime.connectors.toPublic(record, process.env) });
      }
    }
  ];
}
