import {
  NotFoundError,
  canAccessTask,
  filterTasksByAuth,
  parseModelOverrideInput,
  stampOwnerMetadata,
  type RawAgentRuntime,
  type RequestAuth
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { guardBotTaggedMetadata } from '../bot-pin-guard.js';
import { etagFromState, json, sendIfNotModified } from '../http-utils.js';

function imageAssetIdsFromBody(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.imageAssetIds)) return [];
  return body.imageAssetIds.map(String).filter(Boolean);
}

function taskMetadataFromBody(
  runtime: RawAgentRuntime,
  body: Record<string, unknown>,
  auth: RequestAuth
): Record<string, unknown> {
  const extra =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
  guardBotTaggedMetadata(runtime, auth, extra);
  if ('modelOverride' in extra) {
    const pin = parseModelOverrideInput(extra.modelOverride);
    if (pin) extra.modelOverride = pin;
    else delete extra.modelOverride;
  }
  return extra;
}

export function tasksRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/tasks',
      handler: ({ request, response, auth }) => {
        if (sendIfNotModified(request, response, etagFromState(runtime.getStateVersion()))) return;
        json(response, 200, {
          tasks: filterTasksByAuth(runtime.listTasks(), (id) => runtime.getSession(id), auth)
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/tasks',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const result = runtime.createTaskSession({
          title: String(body.title ?? body.goal ?? 'Task'),
          description: typeof body.description === 'string' ? body.description : undefined,
          message: typeof body.message === 'string'
            ? body.message
            : typeof body.goal === 'string' ? body.goal : undefined,
          imageAssetIds: imageAssetIdsFromBody(body),
          agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
          blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : undefined,
          background: body.background !== false,
          metadata: stampOwnerMetadata(taskMetadataFromBody(runtime, body, auth), auth)
        });
        if (body.autoRun !== false) await runtime.runSession(result.session.id);
        json(response, 201, {
          task: runtime.getTask(result.task.id),
          session: runtime.getSession(result.session.id),
          latestAssistant: runtime.getLatestAssistantText(result.session.id)
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/tasks/:id',
      handler: ({ requireParam, response, auth }) => {
        const id = requireParam('id');
        const task = runtime.getTask(id);
        if (!task) throw new NotFoundError('Task');
        const session = task.sessionId ? runtime.getSession(task.sessionId) : undefined;
        if (!canAccessTask(task, session, auth)) throw new NotFoundError('Task');
        json(response, 200, {
          task,
          events: runtime.getTaskEvents(id),
          session
        });
      }
    }
  ];
}
