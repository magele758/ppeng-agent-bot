/**
 * Long-connect for a personal phone / device-local agent in another process.
 * SSE carries op events; POST /reply completes them. Not a Factory route and
 * not the desktop-agent stream. Shell and copy stay off unless the query opts in.
 */

import {
  createDeviceLocalHttpSseSession,
  getSharedDeviceLocalHub
} from '@ppeng/agent-core';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

export function resetDeviceLocalSessionsForTests(): void {
  resetPersonalAgentSessions(sessions);
}

function optedIn(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true';
}

function openDeviceLocalStream(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  machineId: string,
  url: URL
): void {
  const shell = optedIn(url, 'shell');
  const copy = optedIn(url, 'copy');
  sessions.get(machineId)?.close();
  sseInit(response);
  const session = createDeviceLocalHttpSseSession({
    hub: getSharedDeviceLocalHub(),
    machineId,
    shell,
    copy,
    send: (event, data) => sseSend(response, event, data)
  });
  sessions.set(machineId, session);
  bindPersonalAgentClose(request, response, sessions, session);
  sseSend(response, 'ready', { machineId, attached: true, shell, copy });
}

export function deviceLocalRoutes(): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/device-local/:machineId/events',
      handler: ({ request, response, requireParam, url }) => {
        const machineId = machineIdOf(requireParam('machineId'));
        if (!machineId) {
          json(response, 400, { error: 'invalid_machine_id' });
          return;
        }
        openDeviceLocalStream(request, response, machineId, url);
      }
    },
    personalAgentReplyRoute('/api/device-local/:machineId/reply', sessions),
    personalAgentDetachRoute('/api/device-local/:machineId/detach', sessions)
  ];
}
