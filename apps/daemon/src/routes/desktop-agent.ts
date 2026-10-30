/**
 * Long-connect for a personal desktop agent in another process.
 * SSE carries op events; POST /reply completes them. Not a Factory route.
 */

import {
  createDesktopAgentHttpSseSession,
  getSharedDesktopAgentHub,
  type DesktopAgentHttpSseSession
} from '@ppeng/agent-core';

/** Local mirror of RegisteredMachineOpResult — keep daemon free of extra core type exports. */
interface RegisteredMachineOpResult {
  ok: boolean;
  content: string;
  exitCode?: number;
}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, sseInit, sseSend } from '../http-utils.js';
import type { RouteSpec } from '../routing.js';

const MACHINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

const sessions = new Map<string, DesktopAgentHttpSseSession>();

export function resetDesktopAgentSessionsForTests(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

function machineIdOf(raw: string | undefined): string | undefined {
  const id = (raw ?? '').trim();
  return MACHINE_ID.test(id) ? id : undefined;
}

function isOpResult(value: unknown): value is RegisteredMachineOpResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as { ok?: unknown; content?: unknown; exitCode?: unknown };
  if (typeof row.ok !== 'boolean' || typeof row.content !== 'string') return false;
  return row.exitCode === undefined || typeof row.exitCode === 'number';
}

function bindClose(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  session: DesktopAgentHttpSseSession
): void {
  const finish = () => {
    if (sessions.get(session.machineId) === session) sessions.delete(session.machineId);
    session.close();
  };
  request.on('close', finish);
  request.on('error', finish);
  response.on('error', finish);
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
        bindClose(request, response, session);
        sseSend(response, 'ready', { machineId, attached: true });
      }
    },
    {
      method: 'POST',
      pattern: '/api/desktop-agent/:machineId/reply',
      handler: async ({ response, requireParam, readBody }) => {
        const machineId = machineIdOf(requireParam('machineId'));
        if (!machineId) {
          json(response, 400, { error: 'invalid_machine_id' });
          return;
        }
        const session = sessions.get(machineId);
        if (!session || session.closed) {
          json(response, 404, { error: 'no_session' });
          return;
        }
        const body = (await readBody()) as { requestId?: unknown; result?: unknown };
        const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
        if (!requestId || !isOpResult(body?.result)) {
          json(response, 400, { error: 'invalid_reply' });
          return;
        }
        const accepted = session.handleReply({ requestId, result: body.result });
        if (!accepted) {
          json(response, 404, { error: 'unknown_request' });
          return;
        }
        json(response, 200, { ok: true });
      }
    },
    {
      method: 'POST',
      pattern: '/api/desktop-agent/:machineId/detach',
      handler: ({ response, requireParam }) => {
        const machineId = machineIdOf(requireParam('machineId'));
        if (!machineId) {
          json(response, 400, { error: 'invalid_machine_id' });
          return;
        }
        const session = sessions.get(machineId);
        if (!session) {
          json(response, 404, { error: 'no_session' });
          return;
        }
        sessions.delete(machineId);
        session.close();
        json(response, 200, { ok: true, detached: true });
      }
    }
  ];
}
