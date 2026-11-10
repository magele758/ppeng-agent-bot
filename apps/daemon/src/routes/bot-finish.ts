/**
 * GET/PATCH /api/bot-finish/settings — how the runtime follows a Bot turn to the end:
 * attaching follow-ups to an unfinished goal, the soft-stop check of goal-less turns,
 * and wakes for promises to report later. Saved values apply to the next turn.
 */

import { DEFAULT_BOT_FINISH_SETTINGS, ValidationError, readBotFinishSettings, writeBotFinishSettings, type BotFinishSettings, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function payload(runtime: RawAgentRuntime) {
  return { settings: readBotFinishSettings(runtime.store), defaults: DEFAULT_BOT_FINISH_SETTINGS };
}

export function botFinishRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/bot-finish/settings',
      handler: ({ response }) => {
        json(response, 200, payload(runtime));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/bot-finish/settings',
      handler: async (ctx) => {
        const patch = (await ctx.readBody()) as Partial<BotFinishSettings>;
        try {
          writeBotFinishSettings(runtime.store, patch ?? {});
        } catch (error) {
          throw new ValidationError(error instanceof Error ? error.message : String(error));
        }
        json(ctx.response, 200, payload(runtime));
      }
    }
  ];
}
