/**
 * Long-connect for a personal desktop agent in another process.
 * SSE carries op events; POST /reply completes them. Not a Factory route.
 */

import {
  createDesktopAgentHttpSseSession,
  getSharedDesktopAgentHub
} from '@ppeng/agent-core';
import { json, sseInit, sseSend } from '../http-utils.js';
import type { RouteSpec } from '../routing.js';
import {
  bindPersonalAgentClose,
  createPersonalAgentSessions,
  machineIdOf,
  personalAgentDetachRoute,
  personalAgentReplyRoute,
  resetPersonalAgentSessions
} from './personal-agent-http.js';

const sessions = createPersonalAgentSessions();

export function resetDesktopAgentSessionsForTests(): void {
  resetPersonalAgentSessions(sessions);
}

export function desktopAgentRoutes(): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/desktop-agent/:machineId/events',
      handler: ({ request, response, requireParam }) => {
        const machineId = machineIdOf(requireParam('machineId'));
        if (!machineId) {
          json(response, 400, { error: 'invalid_machine_id' });
          return;
        }
        const previous = sessions.get(machineId);
        previous?.close();
        sseInit(response);
        const session = createDesktopAgentHttpSseSession({
          hub: getSharedDesktopAgentHub(),
          machineId,
          send: (event, data) => sseSend(response, event, data)
        });
        sessions.set(machineId, session);
        bindPersonalAgentClose(request, response, sessions, session);
        sseSend(response, 'ready', { machineId, attached: true });
      }
    },
    personalAgentReplyRoute('/api/desktop-agent/:machineId/reply', sessions),
    personalAgentDetachRoute('/api/desktop-agent/:machineId/detach', sessions)
  ];
}
