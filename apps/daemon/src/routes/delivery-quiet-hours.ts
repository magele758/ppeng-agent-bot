/**
 * GET/PATCH /api/delivery/quiet-hours — global quiet window for user-facing outbound.
 * Persisted in daemon_control KV and effective immediately (enforced by UserDeliveryPort).
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import { parseQuietHoursPatch, readQuietHours, writeQuietHours } from '@ppeng/agent-capability-gateway';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function deliveryQuietHoursRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/delivery/quiet-hours',
      handler: ({ response }) => {
        json(response, 200, { settings: readQuietHours(runtime.store) });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/delivery/quiet-hours',
      handler: async ({ readBody, response }) => {
        const settings = writeQuietHours(runtime.store, parseQuietHoursPatch(await readBody()));
        json(response, 200, { settings });
      }
    }
  ];
}
