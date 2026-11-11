/** A skill's identity is useful even when its body and other tool processes are folded. */
export function toolDisplayName(name: string | undefined, input: unknown, formatSkill: (name: string) => string): string {
  const label = name || 'unknown';
  if (label !== 'load_skill') return label;
  const skill = typeof input === 'string' ? streamedSkillName(input) : objectSkillName(input);
  return skill ? formatSkill(skill) : label;
}

function objectSkillName(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as Record<string, unknown>).name;
  return typeof value === 'string' ? value.trim() : '';
}

function streamedSkillName(raw: string): string {
  try { return objectSkillName(JSON.parse(raw)); }
  catch { return partialSkillName(raw); }
}

function partialSkillName(raw: string): string {
  const match = raw.match(/^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!match) return '';
  try { return (JSON.parse(match[1]) as string).trim(); }
  catch { return ''; }
}

export function isSkillLoadPart(part: {type: string; name?: string}): boolean {
  return part.name === 'load_skill' && ['tool_call', 'tool_result'].includes(part.type);
}
