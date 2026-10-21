import type { RunContext, ToolContract } from '../types.js';
import type {SkillManagementService,SkillManagementInput} from './management.js';
import type { SkillCaptureService, SkillCaptureSuggestion } from './capture.js';

export const SKILL_PROPOSE_TOOL_NAME = 'skill_propose';
export interface SkillProposeToolDeps {
  captures: SkillCaptureService;
  management?: SkillManagementService;
  emitTrace?: (sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) => void;
}
export function createSkillProposeTool(deps: SkillProposeToolDeps): ToolContract<SkillCaptureSuggestion & Record<string, unknown>> {
  return {
    name: SKILL_PROPOSE_TOOL_NAME,
    description:
      'Suggest capturing a reusable skill from a successfully completed workflow, or updating an existing skill. ' +
      'Decide whether the experience is worth recording yourself. Submit ONLY an intent (name, description, reason, summary), NOT a skill body. ' +
      'A non-blocking confirmation card appears in this conversation. Only after the human confirms will the runtime distill and save the skill automatically, without a second review. ' +
      'New Bot skills are private by default. For explicit user commands to create/update, or to manage sharing/deletion, use skill_manage; skill_propose is for autonomous suggestions. Use the exact owned skill name and targetSkillId for updates; choose a new name for built-in or ~/.agents skills that cannot be replaced. ' +
      'Do not repeat rejected suggestions. Continue the current task without waiting for a decision. Never include secrets.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetSkillId: { type: 'string', description: 'Exact search result ID for updating an owned skill. Shared skills are read-only; omit to propose a separate private skill.' },
        name: { type: 'string', description: 'Exact target name, lowercase kebab-case, at most 64 characters' },
        description: { type: 'string', description: 'One-line trigger, at most 300 characters' },
        reason: { type: 'string', description: 'Why this successful experience is worth recording, at most 300 characters' },
        summary: { type: 'string', description: 'Scope and planned changes for the human to confirm, at most 2000 characters. Not a skill body.' }
      },
      required: ['name', 'description', 'reason', 'summary']
    },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    async execute(context: RunContext, args) {
      try {
        if(deps.management && typeof context.session.metadata?.botId === 'string'){
          const own=(await deps.management.catalog(context.session.id)).find(s=>s.canManage&&s.name===args.name);
          const input:SkillManagementInput={action:own?'update':'create',skillId:args.targetSkillId??own?.id,name:args.name,description:args.description,reason:args.reason,summary:args.summary};
          const key=context.session.id;
          if(await deps.management.hasExplicitRequest(key,input)){
            const operation=await deps.management.request(key,context.agent.id,input,'user');
            return {ok:operation.status==='saved',content:JSON.stringify({operation,note:'Explicit user command executed; no second body review.'})};
          }
        }
        const capture = await deps.captures.suggest(context.session.id, context.agent.id, args);
        deps.emitTrace?.(context.session.id, { kind: 'skill_propose', payload: { captureId: capture.id, name: capture.name, status: capture.status } });
        return { ok: true, content: JSON.stringify({ capture, note: 'Intent only. Continue the task. The human decides in the conversation; no body is distilled or installed before confirmation.' }) };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
