/**
 * Bot tool allowlist. Empty / omitted means the full catalog (today's behavior).
 * Built-in names are checked against the live tool catalog before they are stored;
 * MCP tool names are accepted even while unregistered, and callers may pass the
 * names of saved PTC dynamic tools, which live outside the static catalog.
 */

import { ValidationError } from '../errors.js';
import { MESSAGE_AGENT_TOOL_NAME } from './bot-tool-names.js';
import { hasLegacyBypassFlag } from './legacy-bypass.js';

const MCP_FIXED_TOOL_NAMES = new Set(['mcp_invoke', 'mcp_list_resources', 'mcp_read_resource']);
const MCP_EXPANDED_TOOL_RE = /^mcp_[hs]\d+_\S+$/;

/** MCP tools register after the first run, so a name can be valid before it is in the catalog. */
export function isMcpToolName(name: string): boolean {
  return MCP_FIXED_TOOL_NAMES.has(name) || MCP_EXPANDED_TOOL_RE.test(name);
}

export function normalizeAllowedToolNames(
  raw: unknown,
  catalog: readonly { name: string }[],
  extraKnownNames: readonly string[] = []
): string[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError('allowedTools must be an array of tool names');
  }
  const known = new Set([...catalog.map((tool) => tool.name), ...extraKnownNames]);
  const names: string[] = [];
  const unknown: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      unknown.push(String(item));
      continue;
    }
    const name = item.trim();
    if (!name) continue;
    if (!known.has(name) && !isMcpToolName(name)) unknown.push(name);
    else if (!names.includes(name)) names.push(name);
  }
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown tools: ${unknown.join(', ')}`);
  }
  return names;
}

/** Non-empty allowlist, or undefined when the bot should keep the full tool set. */
export function readPositiveAllowedTools(
  metadata: Record<string, unknown> | undefined
): string[] | undefined {
  const raw = metadata?.allowedTools;
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
  return names.length > 0 ? names : undefined;
}

/** Tools a Bot needs to plan and pull in skills. Missing ones are warned about, not rejected. */
export const BOT_REQUIRED_TOOLS = ['TodoWrite', 'load_skill', MESSAGE_AGENT_TOOL_NAME] as const;

export type BotPolicyWarning =
  | {
      code: 'missing_required_tools';
      tools: string[];
      /**
       * MCP-form names in the list that the live catalog cannot confirm yet. MCP tools register
       * after their first run, so these are unverifiable rather than wrong. Omitted when empty.
       */
      unverifiedMcpTools?: string[];
    }
  | { code: 'stale_allowed_tools'; tools: string[] }
  /** bypass came from the pre-auto default, not from an owner's choice. */
  | { code: 'legacy_bypass_permission' };

export interface BotPolicyToolContext {
  /** Names in the live tool catalog (built-ins plus already-registered MCP tools). */
  registeredToolNames?: readonly string[];
  /** Saved PTC dynamic tool names for the bot's canonical session. Omit to skip the stale check. */
  dynToolNames?: readonly string[];
}

function unverifiedMcpNames(
  allowedTools: readonly string[],
  registered: ReadonlySet<string> | undefined
): string[] {
  return allowedTools.filter((name) => isMcpToolName(name) && !registered?.has(name));
}

export function botToolAllowlistWarnings(
  allowedTools: readonly string[] | undefined,
  ctx: BotPolicyToolContext = {}
): BotPolicyWarning[] {
  if (!allowedTools || allowedTools.length === 0) return [];
  const registered = ctx.registeredToolNames ? new Set(ctx.registeredToolNames) : undefined;
  const warnings: BotPolicyWarning[] = [];
  const missing = BOT_REQUIRED_TOOLS.filter((name) => !allowedTools.includes(name));
  if (missing.length > 0) {
    const unverified = unverifiedMcpNames(allowedTools, registered);
    warnings.push({
      code: 'missing_required_tools',
      tools: [...missing],
      ...(unverified.length > 0 ? { unverifiedMcpTools: unverified } : {})
    });
  }
  if (registered && ctx.dynToolNames) {
    const dyn = new Set(ctx.dynToolNames);
    const stale = allowedTools.filter(
      (name) => !registered.has(name) && !isMcpToolName(name) && !dyn.has(name)
    );
    if (stale.length > 0) warnings.push({ code: 'stale_allowed_tools', tools: stale });
  }
  return warnings;
}

/** Warnings for a stored bot policy, recomputed on every read so they survive a reload. */
export function botPolicyWarnings(
  metadata: Record<string, unknown> | undefined,
  ctx: BotPolicyToolContext = {}
): BotPolicyWarning[] {
  const warnings = botToolAllowlistWarnings(readPositiveAllowedTools(metadata), ctx);
  if (hasLegacyBypassFlag(metadata)) warnings.push({ code: 'legacy_bypass_permission' });
  return warnings;
}
