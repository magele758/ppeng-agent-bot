import { existsSync, readFileSync } from 'node:fs';
import { envBool } from '../env.js';

export interface OptionalToolGroupItemDef {
  id: string;
  title: string;
  description?: string;
  toolNames: string[];
}

export interface OptionalToolGroupDef {
  id: string;
  title: string;
  description?: string;
  items: OptionalToolGroupItemDef[];
}

/** Default optional tools: gated until user enables a group (when feature flag is on). */
const DEFAULT_OPTIONAL_GROUPS: OptionalToolGroupDef[] = [
  {
    id: 'shell',
    title: 'Shell & background',
    items: [
      {
        id: 'shell-core',
        title: 'bash / bg_run / bg_check',
        toolNames: ['bash', 'bg_run', 'bg_check']
      }
    ]
  },
  {
    id: 'network',
    title: 'Network',
    items: [
      {
        id: 'web',
        title: 'web_fetch / web_search',
        description: 'web_search is hidden until Lab → More → Attachments sets a URL template.',
        toolNames: ['web_fetch', 'web_search']
      }
    ]
  },
  {
    id: 'workspace_search',
    title: 'Glob search',
    items: [{ id: 'glob', title: 'glob_files', toolNames: ['glob_files'] }]
  },
  {
    id: 'subagents',
    title: 'Sub-agents',
    items: [
      {
        id: 'spawn',
        title: 'spawn_subagent / spawn_teammate',
        toolNames: ['spawn_subagent', 'spawn_teammate']
      }
    ]
  },
  {
    id: 'external_ai',
    title: 'External AI CLIs',
    description: 'Requires RAW_AGENT_EXTERNAL_AI_TOOLS and session allowExternalAiTools',
    items: [
      {
        id: 'ext',
        title: 'claude_code / codex_exec / cursor_agent',
        toolNames: ['claude_code', 'codex_exec', 'cursor_agent']
      }
    ]
  },
  {
    id: 'browser',
    title: 'Browser automation',
    description: 'Enable in Lab → 更多 → 浏览器 (or RAW_AGENT_BROWSER_TOOLS). Uses local Playwright; fail-soft if missing.',
    items: [
      {
        id: 'browser-core',
        title: 'browser_navigate / snapshot / screenshot / click / type',
        toolNames: [
          'browser_navigate',
          'browser_snapshot',
          'browser_screenshot',
          'browser_click',
          'browser_type'
        ]
      }
    ]
  },
  {
    id: 'cron',
    title: 'Scheduled jobs',
    description: 'First-class agent cron (cron_create / cron_list / cron_remove / cron_run_now / cron_runs)',
    items: [
      {
        id: 'cron-core',
        title: 'cron_create / cron_list / cron_remove / cron_run_now / cron_runs',
        toolNames: ['cron_create', 'cron_list', 'cron_remove', 'cron_run_now', 'cron_runs']
      }
    ]
  },
  {
    id: 'capability_discovery',
    title: 'Capability discovery',
    description:
      'tool_search / load_capability_tool. Enable master switch in Lab → 更多 → 能力发现 (persisted; not .env).',
    items: [
      {
        id: 'discovery-meta',
        title: 'tool_search / load_capability_tool',
        toolNames: ['tool_search', 'load_capability_tool']
      }
    ]
  },
  {
    id: 'tailscale_ops',
    title: 'Tailscale operations',
    description:
      'Write-ish Tailscale ops (SSH etc.). Default off. Enable Tailscale pool in Lab → 更多 → 能力发现 for read-only list/get.',
    items: [
      {
        id: 'tailscale-ssh',
        title: 'tailscale_ssh / tailscale_ping',
        toolNames: ['tailscale_ssh', 'tailscale_ping']
      }
    ]
  },
  {
    id: 'dyn_tools',
    title: 'Dynamic tool factory',
    description:
      'save_as_tool / propose_tool / search_dyn_tools. Master switch is Lab → More → Dynamic tools (persisted; not .env).',
    items: [
      {
        id: 'dyn-meta',
        title: 'save_as_tool / propose_tool / search_dyn_tools',
        toolNames: ['save_as_tool', 'propose_tool', 'search_dyn_tools']
      }
    ]
  }
];

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeGroups(raw: OptionalToolGroupDef[]): OptionalToolGroupDef[] {
  return raw
    .map((g) => ({
      id: String(g.id ?? '').trim(),
      title: String(g.title ?? g.id ?? '').trim(),
      description: typeof g.description === 'string' ? g.description : undefined,
      items: Array.isArray(g.items)
        ? g.items.map((it) => ({
            id: String(it.id ?? '').trim(),
            title: String(it.title ?? it.id ?? '').trim(),
            description: typeof it.description === 'string' ? it.description : undefined,
            toolNames: uniqueStrings(
              (it.toolNames ?? []).map((n) => String(n).trim()).filter(Boolean)
            )
          }))
        : []
    }))
    .filter((g) => g.id && g.items.length > 0);
}

export function optionalToolGroupsFeatureEnabled(env: NodeJS.ProcessEnv): boolean {
  return envBool(env, 'RAW_AGENT_OPTIONAL_TOOL_GROUPS', false);
}

export function loadOptionalToolGroupsFromEnv(env: NodeJS.ProcessEnv): OptionalToolGroupDef[] {
  const p = env.RAW_AGENT_OPTIONAL_TOOL_GROUPS_PATH?.trim();
  if (p && existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { groups?: OptionalToolGroupDef[] };
      if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
        return normalizeGroups(parsed.groups);
      }
    } catch {
      /* use defaults */
    }
  }
  return DEFAULT_OPTIONAL_GROUPS;
}

export function optionalToolNamesFromGroups(groups: OptionalToolGroupDef[]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) {
    for (const it of g.items) {
      for (const n of it.toolNames) {
        s.add(n);
      }
    }
  }
  return s;
}

export interface OptionalToolGroupsPayload {
  groups: Array<{
    id: string;
    title: string;
    description?: string;
    items: Array<{ id: string; title: string; description?: string; tool_names: string[] }>;
  }>;
}

export function buildOptionalToolGroupsPayload(groups: OptionalToolGroupDef[]): OptionalToolGroupsPayload {
  return {
    groups: groups.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      items: g.items.map((it) => ({
        id: it.id,
        title: it.title,
        description: it.description,
        tool_names: [...it.toolNames]
      }))
    }))
  };
}

export interface ResolvedOptionalToolGroups {
  enabledGroups: string[];
  enabledToolNames: string[];
  unknownGroups: string[];
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return uniqueStrings(input.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean));
}

/**
 * Parse server-default optional group ids from env
 * (`RAW_AGENT_DEFAULT_ENABLED_OPTIONAL_GROUPS`, comma-separated).
 * Unknown ids are kept here and reported later by {@link resolveOptionalToolGroups}.
 */
export function parseDefaultEnabledOptionalGroups(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RAW_AGENT_DEFAULT_ENABLED_OPTIONAL_GROUPS?.trim();
  if (!raw) return [];
  return uniqueStrings(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Union of server defaults and client/session selection (order: defaults then client;
 * duplicates removed). Mirrors ai-agent-node `DEFAULT_ENABLED_OPTIONAL_GROUPS` ∪ client.
 */
export function mergeEnabledOptionalToolGroups(
  serverDefaults: unknown,
  clientEnabled: unknown
): string[] {
  return uniqueStrings([...normalizeStringArray(serverDefaults), ...normalizeStringArray(clientEnabled)]);
}

export function resolveOptionalToolGroups(
  enabledGroupIds: unknown,
  groups: OptionalToolGroupDef[]
): ResolvedOptionalToolGroups {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const requested = normalizeStringArray(enabledGroupIds);
  const enabledGroups: string[] = [];
  const enabledToolNames: string[] = [];
  const unknownGroups: string[] = [];

  for (const groupId of requested) {
    const group = groupById.get(groupId);
    if (!group) {
      unknownGroups.push(groupId);
      continue;
    }
    enabledGroups.push(group.id);
    for (const item of group.items) {
      enabledToolNames.push(...item.toolNames);
    }
  }

  return {
    enabledGroups: uniqueStrings(enabledGroups),
    enabledToolNames: uniqueStrings(enabledToolNames),
    unknownGroups: uniqueStrings(unknownGroups)
  };
}

export function filterToolsByOptionalGroups<T extends { name: string }>(
  tools: T[],
  enabledGroupIds: unknown,
  groups: OptionalToolGroupDef[]
): { tools: T[]; resolved: ResolvedOptionalToolGroups } {
  const optionalNames = optionalToolNamesFromGroups(groups);
  const resolved = resolveOptionalToolGroups(enabledGroupIds, groups);
  const enabled = new Set(resolved.enabledToolNames);
  return {
    resolved,
    tools: tools.filter((t) => !optionalNames.has(t.name) || enabled.has(t.name))
  };
}
