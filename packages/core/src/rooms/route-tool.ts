import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';
import { routeRoomTurnFromTool } from './host-route.js';

/** Host selects who speaks in this round. Assigning tasks is a later phase. */
export function createRoomRouteTool(): ToolContract<Record<string, unknown>> {
  return {
    name: 'room_route_turn',
    description: 'Room host only. Choose which current members speak in this round, by bot id. Names alone do not schedule anyone. assign_tasks is not available.',
    inputSchema: {
      type: 'object',
      properties: {
        botIds: { type: 'array', items: { type: 'string' } },
        summarize: { type: 'boolean' },
        mode: { type: 'string', enum: ['direct_answer', 'select_experts', 'assign_tasks'] }
      },
      required: ['botIds']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context: RunContext, args): Promise<ToolExecutionResult> {
      if (args.mode === 'assign_tasks') return { ok: false, content: 'Assigning tasks is not available in this round.' };
      const ids = Array.isArray(args.botIds) ? args.botIds.filter((id): id is string => typeof id === 'string') : [];
      try {
        const accepted = routeRoomTurnFromTool(context.session.id, ids, { summarize: args.summarize === true });
        return { ok: true, content: accepted.length ? `Selected ${accepted.join(', ')}` : 'No additional members selected' };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
