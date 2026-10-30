/**
 * Shared bookkeeping for personal-agent HTTP/SSE sessions.
 * Desktop and phone each keep their own map and hub. Not a Factory route.
 */

import type { DesktopAgentHttpSseSession } from '@ppeng/agent-core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from '../http-utils.js';
import type { RouteContext, RouteSpec } from '../routing.js';

const MACHINE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

interface RegisteredMachineOpResult {
  ok: boolean;
  content: string;
  exitCode?: number;
}

export function createPersonalAgentSessions(): Map<string, DesktopAgentHttpSseSession> {
  return new Map();
}

export function resetPersonalAgentSessions(sessions: Map<string, DesktopAgentHttpSseSession>): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

export function machineIdOf(raw: string | undefined): string | undefined {
  const id = (raw ?? '').trim();
  return MACHINE_ID.test(id) ? id : undefined;
}

function liveSession(
  sessions: Map<string, DesktopAgentHttpSseSession>,
  machineId: string
): DesktopAgentHttpSseSession | undefined {
  const session = sessions.get(machineId);
  if (!session || session.closed) return undefined;
  return session;
}

function isOpResult(value: unknown): value is RegisteredMachineOpResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as { ok?: unknown; content?: unknown };
  return typeof row.ok === 'boolean' && typeof row.content === 'string';
}

function exitCodeOk(value: RegisteredMachineOpResult): boolean {
  return value.exitCode === undefined || typeof value.exitCode === 'number';
}

export function bindPersonalAgentClose(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  sessions: Map<string, DesktopAgentHttpSseSession>,
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

export function personalAgentReplyRoute(
  pattern: string,
  sessions: Map<string, DesktopAgentHttpSseSession>
): RouteSpec {
  return {
    method: 'POST',
    pattern,
    handler: async ({ response, requireParam, readBody }) => {
      const machineId = machineIdOf(requireParam('machineId'));
      if (!machineId) {
        json(response, 400, { error: 'invalid_machine_id' });
        return;
      }
      const session = liveSession(sessions, machineId);
      if (!session) {
        json(response, 404, { error: 'no_session' });
        return;
      }
      const body = (await readBody()) as { requestId?: unknown; result?: unknown };
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      if (!requestId || !isOpResult(body?.result) || !exitCodeOk(body.result)) {
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
  };
}

export function personalAgentDetachRoute(
  pattern: string,
  sessions: Map<string, DesktopAgentHttpSseSession>
): RouteSpec {
  return {
    method: 'POST',
    pattern,
    handler: ({ response, requireParam }: RouteContext) => {
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
  };
}
