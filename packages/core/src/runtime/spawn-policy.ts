import { readAllowedSkillNames } from '../skills/skill-allowlist.js';
import { readSessionModelOverride, type SessionModelOverride } from '../model/provider-catalog.js';

/**
 * Subagent inheritance. Children keep the effective permission mode and do not
 * copy the whole scratch pad unless the caller already supplied a key filter.
 */

export function isBotParentSession(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata.canonicalBotChat === true) return true;
  const botId = metadata.botId;
  return typeof botId === 'string' && botId.trim().length > 0;
}

/** Child permissionMode. Undefined means "do not set" (same as a parent with no mode). */
export function childPermissionMode(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const raw = metadata?.permissionMode;
  const parentMode = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  return parentMode;
}

export function copyScratchOnSpawn(
  metadata: Record<string, unknown> | undefined,
  scratchKeyFilter: ((key: string) => boolean) | undefined
): 'all' | 'filter' | 'skip' {
  if (isBotParentSession(metadata)) {
    return scratchKeyFilter ? 'filter' : 'skip';
  }
  return scratchKeyFilter ? 'filter' : 'all';
}

/**
 * Children follow the parent's model pin (Bot setting or an inherited
 * spawn_subagent `model`). Empty when the parent has none. An explicit
 * `model` passed to spawn_subagent is applied by the caller and wins.
 */
export function inheritModelOverride(
  metadata: Record<string, unknown> | undefined
): { modelOverride?: SessionModelOverride } {
  const pinned = readSessionModelOverride(metadata);
  return pinned ? { modelOverride: pinned } : {};
}

/**
 * Teammates from non-Bot parents keep today's behavior (no inherited mode). A
 * Bot parent passes its effective mode down like subagents, so
 * a plan/ask Bot cannot fall back to the auto default via a teammate.
 */
export function botTeammatePermission(
  metadata: Record<string, unknown> | undefined
): { permissionMode?: string } {
  if (!isBotParentSession(metadata)) return {};
  const mode = childPermissionMode(metadata);
  return mode ? { permissionMode: mode } : {};
}

function readToolNames(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const raw = metadata?.allowedTools;
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
  return names.length > 0 ? names : undefined;
}

/**
 * Bot allowlists carried into spawned children. `allowedSkills` is copied as is.
 * `allowedTools` is the parent list narrowed by the child's own limits (agent spec,
 * explicit spawn request); an empty intersection keeps the parent list so a child
 * is never left with no tools. Non-Bot parents and parents with no list (= full
 * catalog) write nothing, so the request's own list stays as the caller set it.
 */
export function inheritBotAllowlists(
  metadata: Record<string, unknown> | undefined,
  childLimits?: { agentAllowedTools?: readonly string[]; requestedTools?: readonly string[] }
): { allowedTools?: string[]; allowedSkills?: string[] } {
  if (!isBotParentSession(metadata)) return {};
  const out: { allowedTools?: string[]; allowedSkills?: string[] } = {};
  const parentTools = readToolNames(metadata);
  if (parentTools) {
    let tools = parentTools;
    for (const limit of [childLimits?.agentAllowedTools, childLimits?.requestedTools]) {
      if (!limit || limit.length === 0) continue;
      const allow = new Set(limit);
      const narrowed = tools.filter((name) => allow.has(name));
      if (narrowed.length > 0) tools = narrowed;
    }
    out.allowedTools = tools;
  }
  const skills = readAllowedSkillNames(metadata);
  if (skills) out.allowedSkills = skills;
  return out;
}
