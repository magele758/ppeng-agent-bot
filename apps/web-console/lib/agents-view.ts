import type { BotInfo } from './types';

export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  instructions?: string;
  capabilities?: string[];
  allowedTools?: string[];
  domainId?: string;
  harnessRole?: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'workspace' | 'agents' | 'user';
  skillPath?: string;
  aliases?: string[];
  triggerWords?: string[];
}

export const SKILL_SOURCES: readonly SkillItem['source'][] = ['builtin', 'workspace', 'agents', 'user'];

function needles(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((n) => n.length > 0);
}

function matchesAll(haystack: string, query: string): boolean {
  const hay = haystack.toLowerCase();
  return needles(query).every((n) => hay.includes(n));
}

export function filterAgents<T extends Pick<AgentDetail, 'id' | 'name' | 'role' | 'domainId'>>(
  agents: readonly T[],
  query: string
): T[] {
  if (!query.trim()) return [...agents];
  return agents.filter((a) => matchesAll([a.id, a.name, a.role, a.domainId ?? ''].join(' '), query));
}

export function filterBots(bots: readonly BotInfo[], query: string): BotInfo[] {
  if (!query.trim()) return [...bots];
  return bots.filter((b) => matchesAll([b.id, b.name, b.title, b.description, b.agentId].join(' '), query));
}

export function filterSkills(
  skills: readonly SkillItem[],
  query: string,
  source: SkillItem['source'] | 'all' = 'all'
): SkillItem[] {
  return skills.filter((s) => {
    if (source !== 'all' && s.source !== source) return false;
    if (!query.trim()) return true;
    const hay = [s.id, s.name, s.description, ...(s.aliases ?? []), ...(s.triggerWords ?? [])].join(' ');
    return matchesAll(hay, query);
  });
}

export type AgentToolScope = { kind: 'all' } | { kind: 'limited'; tools: string[] };

/** 未声明 allowedTools（或为空）即不限制，可使用全部工具。 */
export function agentToolScope(agent: Pick<AgentDetail, 'allowedTools'>): AgentToolScope {
  const tools = (agent.allowedTools ?? []).filter((n) => typeof n === 'string' && n.trim().length > 0);
  return tools.length === 0 ? { kind: 'all' } : { kind: 'limited', tools: [...tools].sort() };
}

export type BotNameIssue = 'empty' | 'taken';

/** Trimmed name must be non-empty and not already used (case-insensitive). */
export function botNameIssue(name: string, takenNames?: readonly string[]): BotNameIssue | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (takenNames?.some((existing) => existing.trim().toLowerCase() === trimmed.toLowerCase())) return 'taken';
  return null;
}
