import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';
import { routeRoomTurnFromTool, roomTaskRouteReceipt } from './host-route.js';

/** Host selects who speaks in this round. Assigning tasks is a later phase. */
export function createRoomRouteTool(): ToolContract<Record<string, unknown>> {
  return {
    name: 'room_route_turn',
    description: 'Room host or task owner only. Choose members. In task-collaboration, each new member requires assignments with a concrete task and expected evidence; review returned evidence with reviewedTaskIds, and completeGoal only after verifying the goal. Other modes do not support task assignments.',
    inputSchema: {
      type: 'object',
      properties: {
        botIds: { type: 'array', items: { type: 'string' } },
        summarize: { type: 'boolean' },
        assignments: { type: 'array', items: { type: 'object', properties: { botId: { type: 'string' }, task: { type: 'string' }, evidence: { type: 'string' } }, required: ['botId', 'task', 'evidence'] } },
        reviewedTaskIds: { type: 'array', items: { type: 'string' } },
        completeGoal: { type: 'boolean' },
        verificationSummary: { type: 'string' },
        evidenceMessageIds: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['direct_answer', 'select_experts', 'assign_tasks'] }
      },
      required: ['botIds']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context: RunContext, args): Promise<ToolExecutionResult> {
      const ids = Array.isArray(args.botIds) ? args.botIds.filter((id): id is string => typeof id === 'string') : [];
      try {
        const accepted = routeRoomTurnFromTool(context.session.id, ids, { mode: typeof args.mode === 'string' ? args.mode : undefined, summarize: args.summarize === true, assignments: Array.isArray(args.assignments) ? args.assignments as { botId: string; task: string; evidence: string }[] : undefined, reviewedTaskIds: Array.isArray(args.reviewedTaskIds) ? args.reviewedTaskIds.filter((id): id is string => typeof id === 'string') : undefined, completeGoal: args.completeGoal === true, verificationSummary: typeof args.verificationSummary === 'string' ? args.verificationSummary : undefined, evidenceMessageIds: Array.isArray(args.evidenceMessageIds) ? args.evidenceMessageIds.filter((id): id is string => typeof id === 'string') : undefined });
        return { ok: true, content: roomTaskRouteReceipt(context.session.id) ?? (accepted.length ? `Selected ${accepted.join(', ')}` : 'No additional members selected') };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
