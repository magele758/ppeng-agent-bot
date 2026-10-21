/**
 * Skill load_skill / search_skills resolvers extracted from RawAgentRuntime.
 */

import { envBool } from '../env.js';
import type { PromptBuilder } from '../model/prompt-builder.js';
import { skillLoadStrictFromEnv, skillRoutingModeFromEnv } from '../skills/skill-router.js';
import { isSkillAllowed } from '../skills/skill-allowlist.js';
import { discloseSkillBody, formatDisclosedSkillContent } from '../skills/skill-disclosure.js';
import type { TraceEvent } from '../stores/trace.js';

export interface SkillLoadHost {
  promptBuilder: PromptBuilder;
  emitTrace(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void;
}

function clampSearchLimit(raw: unknown, fallback = 8): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(20, Math.max(1, Math.floor(n)));
}

export async function resolveSkillSearch(
  host: SkillLoadHost,
  query: string,
  sessionId: string,
  limit?: unknown
): Promise<{ content: string }> {
  const q = String(query ?? '').trim();
  if (!q) {
    return { content: JSON.stringify({ query: q, hits: [], hint: 'Provide a short task query.' }, null, 2) };
  }
  const topK = clampSearchLimit(limit);
  const hits = await host.promptBuilder.searchSkills(q, sessionId, topK);
  void host.emitTrace(sessionId, {
    kind: 'skill_search',
    payload: { query: q, limit: topK, hitCount: hits.length, names: hits.map((h) => h.name) }
  });
  return {
    content: JSON.stringify(
      {
        query: q,
        hits: hits.map((h) => ({
          id: h.id,
          ownerBotId: h.ownerBotId,
          name: h.name,
          description: h.description,
          score: h.score,
          reason: h.reason
        })),
        hint:
          hits.length === 0
            ? 'No matching skills. Try a shorter query, or load_skill with an exact name if you know it.'
            : 'Call load_skill with an exact id from hits when names overlap.'
      },
      null,
      2
    )
  };
}

export async function resolveSkillLoad(
  host: SkillLoadHost,
  name: string,
  sessionId: string
): Promise<{ content?: string; error?: string }> {
  const skills = await host.promptBuilder.skillsForSession(sessionId);
  const normalizedName = name.trim().toLowerCase();
  const matches = skills.filter((skill) => {
    const lookupKeys = [skill.name, skill.id, ...(skill.aliases ?? [])];
    return lookupKeys.some((candidate) => candidate.trim().toLowerCase() === normalizedName);
  });
  const exact = matches.find(s => s.ownerBotId && s.id.toLowerCase() === normalizedName);
  if (!exact && matches.length > 1) return { error: `Ambiguous skill "${name}". Choose an id: ${matches.map(s => `${s.id} (Bot ${s.ownerBotId ?? 'shared'})`).join(', ')}` };
  const found = exact ?? matches[0];
  if (!found?.content) {
    return { error: `Skill "${name}" not found.` };
  }
  if (!isSkillAllowed(found, host.promptBuilder.getAllowedSkills(sessionId))) {
    void host.emitTrace(sessionId, {
      kind: 'skill_load',
      payload: {
        name,
        skillId: found.id,
        skillName: found.name,
        rejected: true,
        reason: 'not_in_allowed_skills'
      }
    });
    return { error: `Skill "${found.name}" is not enabled for this session.` };
  }

  const disclosure = host.promptBuilder.getSkillDisclosure();
  const mode = skillRoutingModeFromEnv(process.env);
  const routing = host.promptBuilder.getRouting(sessionId);
  const shortlist = new Set(routing?.shortlistNames ?? []);
  const searchNames = new Set(host.promptBuilder.getLastSkillSearchNames(sessionId) ?? []);
  const inShortlist =
    disclosure === 'full' || mode === 'legacy' || !routing
      ? true
      : shortlist.has(found.name) || shortlist.has(found.id);
  const inSearch = searchNames.has(found.name) || searchNames.has(found.id);
  const isStrict =
    disclosure !== 'full' &&
    skillLoadStrictFromEnv(process.env) &&
    (disclosure === 'lazy' || mode !== 'legacy');

  if (isStrict && disclosure === 'lazy') {
    if (searchNames.size === 0) {
      void host.emitTrace(sessionId, {
        kind: 'skill_load',
        payload: {
          name,
          skillId: found.id,
          skillName: found.name,
          inShortlist: false,
          rejected: true,
          reason: 'strict_lazy_no_search'
        }
      });
      return {
        error: `Skill "${found.name}" cannot be loaded until search_skills has been called this session (lazy disclosure + strict).`
      };
    }
    if (!inSearch) {
      const suggestions = [...searchNames].slice(0, 3).join(', ');
      void host.emitTrace(sessionId, {
        kind: 'skill_load',
        payload: {
          name,
          skillId: found.id,
          skillName: found.name,
          inShortlist: false,
          rejected: true,
          reason: 'strict_off_search',
          confidence: routing?.confidence.level
        }
      });
      return {
        error: `Skill "${found.name}" is not in the latest search_skills results. Strict mode is ON. Try one of these: ${suggestions || 'none suggested'}`
      };
    }
  } else if (isStrict && !inShortlist) {
    const suggestions = routing?.routed.slice(0, 3).map((r) => r.skill.name).join(', ');
    void host.emitTrace(sessionId, {
      kind: 'skill_load',
      payload: { name, skillId: found.id, skillName: found.name, inShortlist: false, rejected: true, reason: 'strict_off_shortlist', confidence: routing?.confidence.level }
    });
    return { error: `Skill "${found.name}" is not in the current turn's shortlist. Strict mode is ON. Try one of these: ${suggestions || 'none suggested'}` };
  }

  const listed =
    disclosure === 'lazy' ? inSearch || inShortlist : inShortlist;
  void host.emitTrace(sessionId, {
    kind: 'skill_load',
    payload: {
      name,
      skillId: found.id,
      skillName: found.name,
      inShortlist: listed,
      rejected: false,
      override:
        disclosure === 'lazy'
          ? !inSearch
          : disclosure === 'full'
            ? false
            : !inShortlist && mode !== 'legacy',
      confidence: routing?.confidence.level
    }
  });
  const progressive = envBool(process.env, 'RAW_AGENT_SKILL_PROGRESSIVE', true);
  const disclosed = discloseSkillBody(found.content, { progressive });
  return { content: formatDisclosedSkillContent(disclosed) };
}
