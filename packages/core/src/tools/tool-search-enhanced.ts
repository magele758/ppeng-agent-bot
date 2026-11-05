import { authorizeToolsForSession, filterToolsForSession } from '../turn/resolve-turn-tools.js';
import type { AgentSpec, SessionRecord, ToolContract, ToolExecutionResult } from '../types.js';
import { toolGroup } from './tool-exposure.js';
import { rankToolSearch } from './tool-search-ranking.js';
import type { ToolSearchServices } from './tool-search.js';

export type ToolSearchArgs = { query: string; limit?: number; group?: string; offset?: number }
type SearchContext = { session?: SessionRecord; agent?: AgentSpec };

function catalogFor(ctx: SearchContext, services: ToolSearchServices) {
  if (!ctx.session || !ctx.agent || !services.getCatalog) return {tools: [], visible: new Set<string>()};
  const input = {tools: services.getCatalog(), session: ctx.session, agent: ctx.agent,
    env: services.env ?? process.env, settingsStore: services.settingsStore};
  const tools = authorizeToolsForSession(input).tools;
  const visible = new Set(filterToolsForSession(input).tools.map(tool => tool.name));
  return {tools, visible};
}

function browseGroups(tools: ToolContract<any>[]) {
  const groups = new Map<string, {id: string; label: string; count: number}>();
  for (const tool of tools) {
    const group = toolGroup(tool.name);
    const item = groups.get(group.id) ?? {id: group.id, label: `${group.labelZh} / ${group.labelEn}`, count: 0};
    item.count++;
    groups.set(group.id, item);
  }
  return [...groups.values()].sort((a,b) => a.id.localeCompare(b.id));
}

type LocalHit = {source: string; name: string; description: string; group: string; state: string; reason?: string};

function discloseHit(tool: ToolContract<any>, visible: Set<string>, ctx: SearchContext, services: ToolSearchServices): LocalHit {
  const hit = {source: 'local_tool', name: tool.name, description: tool.description ?? '', group: toolGroup(tool.name).id};
  if (visible.has(tool.name)) return {...hit, state: 'already_loaded'};
  try {
    if (!ctx.session || !services.discloseTool) throw new Error('Tool loading is unavailable');
    services.discloseTool(ctx.session.id, tool.name);
    return {...hit, state: 'loaded'};
  } catch (error) {
    return {...hit, state: 'load_failed', reason: error instanceof Error ? error.message : 'Load failed'};
  }
}

function pageOffset(offset: number | undefined): number {
  return Number.isSafeInteger(offset) && Number(offset) > 0 ? Number(offset) : 0;
}

export function enhancedToolSearch(
  ctx: SearchContext, args: ToolSearchArgs, services: ToolSearchServices, limit: number,
  externalHits: unknown[], externalDiscoveryEnabled: boolean
): ToolExecutionResult {
  const {tools, visible} = catalogFor(ctx, services);
  const candidates = args.group ? tools.filter(tool => toolGroup(tool.name).id === args.group) : tools;
  const ranked = rankToolSearch(candidates, String(args.query ?? ''));
  const offset = pageOffset(args.offset);
  const local = ranked.slice(offset, offset + limit).map(tool => discloseHit(tool, visible, ctx, services));
  // External cards are informational; never count them as newly callable tools.
  const cards = args.group || offset > 0 ? [] : externalHits.slice(0, limit - local.length);
  const hits = [...local, ...cards];
  const loaded = local.filter(hit => hit.state === 'loaded').map(hit => hit.name);
  const failures = local.filter(hit => hit.state === 'load_failed').map(hit => ({name: hit.name, reason: hit.reason}));
  return {ok: failures.length === 0, content: JSON.stringify({
    strategy: 'enhanced', budget: limit, candidateCount: candidates.length, matchedCount: ranked.length,
    count: hits.length, hits, loaded, failures,
    nextOffset: offset + limit < ranked.length ? offset + limit : null,
    groups: browseGroups(tools),
    guidance: 'Use already_loaded tools directly; newly loaded tools are callable next turn. For no match, shorten the query or browse with query="" and group=<id>; pass nextOffset as offset for the next page. External capability cards are informational, not executable tools.',
    status: failures.length ? 'load_failed' : hits.length ? 'matched' : 'no_match', externalDiscoveryEnabled
  }, null, 2)};
}
