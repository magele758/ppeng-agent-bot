/**
 * On-demand tool disclosure.
 *
 * Only tools marked `disclosure: 'on_demand'` can be withheld. A name listed
 * in session metadata, or pinned by a non-empty agent allowlist, stays
 * visible. Everything else stays visible. This module does not look at the
 * user message.
 */

export const DISCLOSED_TOOL_NAMES_META = 'disclosedToolNames';

export function withOnDemandDisclosure<T extends object>(tool: T): T {
  return { ...tool, disclosure: 'on_demand' } as T;
}

export function isOnDemandTool(tool: object): boolean {
  return (tool as { disclosure?: unknown }).disclosure === 'on_demand';
}

export function readDisclosedToolNames(
  metadata: Record<string, unknown> | null | undefined
): string[] {
  const raw = metadata?.[DISCLOSED_TOOL_NAMES_META];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) names.push(item);
  }
  return names;
}

export function splitDeferredTools<T extends { name: string }>(input: {
  tools: readonly T[];
  agentAllowedTools?: readonly string[] | null;
  disclosedNames: readonly string[];
}): { visible: T[]; hidden: T[] } {
  const disclosed = new Set(input.disclosedNames);
  const allowed = input.agentAllowedTools;
  const pinned = allowed != null && allowed.length > 0 ? new Set(allowed) : null;
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const tool of input.tools) {
    if (!isOnDemandTool(tool)) {
      visible.push(tool);
      continue;
    }
    if (disclosed.has(tool.name) || (pinned?.has(tool.name) ?? false)) {
      visible.push(tool);
      continue;
    }
    hidden.push(tool);
  }
  return { visible, hidden };
}
