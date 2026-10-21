import { createHash } from 'node:crypto';
import type { SkillSpec } from '../types.js';

export function botSkillId(ownerBotId: string, name: string): string {
  return `bot-skill-${createHash('sha256').update(JSON.stringify([ownerBotId, name])).digest('hex')}`;
}
export function filterSkillsByBot(skills: SkillSpec[], botId?: string): SkillSpec[] {
  return skills.filter(s => !s.ownerBotId || (!!botId && (s.ownerBotId === botId || s.sharedBotIds?.includes(botId))));
}
export function sessionBotId(metadata?: Record<string, unknown>): string | undefined {
  return typeof metadata?.botId === 'string' && metadata.botId ? metadata.botId : undefined;
}
