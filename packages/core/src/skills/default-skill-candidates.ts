import type { SkillSpec } from '../types.js';

/** Keep the shared recommendation pool small; the full catalog remains searchable. */
export function defaultSkillCandidates(skills: SkillSpec[], selected: string[] = []): SkillSpec[] {
  const explicit = new Set(selected.map(name => name.toLowerCase()));
  return skills.filter(skill => {
    if (skill.ownerBotId) return true;
    if (explicit.has(skill.id.toLowerCase()) || explicit.has(skill.name.toLowerCase())) return true;
    return skill.source === 'builtin' && ['planning', 'subagents'].includes(skill.id);
  });
}
