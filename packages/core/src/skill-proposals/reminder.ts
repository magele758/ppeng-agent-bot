import type { AgentSpec, SessionRecord } from '../types.js';
import { readSkillProposalSettings, type SkillProposalSettingsStore } from './settings.js';

const TOOL_NAME = 'skill_propose';

function toolVisible(agent: Pick<AgentSpec, 'allowedTools'>, session: Pick<SessionRecord, 'metadata'>): boolean {
  if (agent.allowedTools && agent.allowedTools.length > 0 && !agent.allowedTools.includes(TOOL_NAME)) {
    return false;
  }
  const metaAllowed = session.metadata?.allowedTools;
  if (Array.isArray(metaAllowed) && metaAllowed.length > 0) {
    return metaAllowed.map(String).includes(TOOL_NAME);
  }
  return true;
}

/**
 * Turn-tail nudge (user side, view-only — never part of the system prompt, so the
 * prompt cache is untouched). `turn` is the 0-based iteration index within this run:
 * fires on iterations N, 2N, … when the persisted N > 0 and the switch is on.
 */
export function buildSkillProposeReminder(input: {
  settingsStore: SkillProposalSettingsStore | undefined;
  turn: number;
  agent: Pick<AgentSpec, 'allowedTools'>;
  session: Pick<SessionRecord, 'metadata'>;
}): string {
  const settings = readSkillProposalSettings(input.settingsStore);
  const n = settings.remindEveryNToolCalls;
  if (!settings.enabled || n <= 0 || input.turn <= 0 || input.turn % n !== 0) return '';
  if (!toolVisible(input.agent, input.session)) return '';
  return (
    `[skill-review reminder] ${input.turn} tool iterations so far in this run. ` +
    'If you have just completed a successful, non-trivial workflow worth reusing or improving an existing skill, ' +
    'call skill_propose with only the name, description, reason and summary to request human confirmation BEFORE distillation. ' +
    'After confirmation the runtime distills and saves automatically. Do not write a skill body before confirmation. ' +
    'Never repeat a rejected suggestion. If nothing is worth recording, ignore this note and continue the task.'
  );
}
