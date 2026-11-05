import type { SkillSpec } from '../types.js';

/** Keep the shared recommendation pool small; the full catalog remains searchable. */
export function defaultSkillCandidates(skills: SkillSpec[]): SkillSpec[] {
  return skills.filter(skill => {
    if (skill.ownerBotId) return true;
    return skill.source === 'builtin' && ['planning', 'subagents'].includes(skill.id);
  });
}
