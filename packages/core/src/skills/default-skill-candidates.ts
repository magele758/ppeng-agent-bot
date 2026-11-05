import type { SkillSpec } from '../types.js';

/** Keep the shared recommendation pool small; the full catalog remains searchable. */
export function defaultSkillCandidates(skills: SkillSpec[], allowed?: readonly string[]): SkillSpec[] {
  if (allowed?.length) return skills;
  return skills.filter(skill => {
    if (skill.ownerBotId) return true;
    return skill.source === 'builtin' && ['planning', 'subagents'].includes(skill.id);
  });
}
