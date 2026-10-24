import { toolGroup } from './tool-exposure.js';
/**
 * Tool Search meta-tools — progressive disclosure for bound capabilities.
 */

import { envBool, envInt } from '../env.js';
import type { CapabilityCard } from '../discovery/types.js';
import type { CapabilityRegistry } from '../discovery/registry.js';
import {
  resolveDiscoveryEnabled,
  type DiscoverySettingsStore
} from '../discovery/settings.js';
import { hiddenDeferredToolsForSession } from '../turn/resolve-turn-tools.js';
import type { AgentSpec, SessionRecord, ToolContract, ToolExecutionResult } from '../types.js';

/** Env-only helper for unit tests; runtime should use resolveDiscoveryEnabled(store). */
export function discoveryToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(env, 'RAW_AGENT_DISCOVERY', false);
}

export function toolDisclosureBudget(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, 'RAW_AGENT_TOOL_DISCLOSURE_BUDGET', 20);
}

export function toolLoadStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(env, 'RAW_AGENT_TOOL_LOAD_STRICT', false);
}

function scoreCard(card: CapabilityCard, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const hay = `${card.name} ${card.description ?? ''} ${card.kind} ${(card.tags ?? []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const token of q.split(/\s+/)) {
    if (hay.includes(token)) score += 2;
    if (card.name.toLowerCase().includes(token)) score += 3;
  }
  return score;
}

export interface ToolSearchHit {
  id: string;
  name: string;
  description?: string;
  kind: string;
  trust: string;
  risk?: string;
}

export function searchBoundCapabilities(
  registry: CapabilityRegistry,
  query: string,
  limit: number
): ToolSearchHit[] {
  const cards = registry.listBoundCards({ limit: 500 });
  const scored = cards
    .map((c) => ({ c, s: scoreCard(c, query) }))
    .filter((x) => x.s > 0 || !query.trim())
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(({ c }) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    trust: c.trust,
    risk: c.scope.includes('write') ? 'write' : 'read'
  }));
}

const DISCOVERY_DISABLED =
  'Capability discovery is disabled (enable in Lab → 更多 → 能力发现)';

export interface ToolSearchServices {
  getRegistry: () => CapabilityRegistry;
  /** Session shortlist of capability ids (for strict load). */
  getShortlist?: (sessionId: string) => string[];
  env?: NodeJS.ProcessEnv;
  /** Prefer persisted UI settings; falls back to env when unset. */
  settingsStore?: DiscoverySettingsStore;
  isEnabled?: () => boolean;
  /** Full catalog, read when a search or load runs. Omit to keep capability-only search. */
  getCatalog?: () => ToolContract<any>[];
  /** Persist a disclosed on-demand tool name on the session. */
  discloseTool?: (sessionId: string, name: string) => void;
}

function deferredSettings(
  store: DiscoverySettingsStore | undefined
): { getDaemonControl(key: string): unknown } | undefined {
  if (!store) return undefined;
  return {
    getDaemonControl(key: string): unknown {
      return store.getDaemonControl<unknown>(key);
    }
  };
}

function hiddenOnDemandTools(
  ctx: { session?: SessionRecord; agent?: AgentSpec } | undefined,
  services: ToolSearchServices
): ToolContract<any>[] {
  if (!services.getCatalog || !ctx?.session || !ctx.agent) return [];
  const tools = services.getCatalog();
  if (!Array.isArray(tools)) return [];
  return hiddenDeferredToolsForSession({
    env: services.env ?? process.env,
    tools,
    agent: ctx.agent,
    session: ctx.session,
    settingsStore: deferredSettings(services.settingsStore)
  });
}

function deferredQueryMatches(tool: { name: string; description?: string }, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).map(token => token.replace(/^\+/, '')).filter(Boolean);
  if (tokens.length === 0) return true;
  const group=toolGroup(tool.name);
  const hay = `${tool.name} ${tool.description ?? ''} ${group.id} ${group.labelEn} ${group.labelZh}`.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

function deferredToolHits(
  tools: readonly ToolContract<any>[],
  query: string,
  limit: number
): Array<{ source: 'deferred_tool'; name: string; description: string }> {
  return tools
    .filter((tool) => deferredQueryMatches(tool, query))
    .slice(0, limit)
    .map((tool) => ({
      source: 'deferred_tool',
      name: tool.name,
      description: tool.description ?? ''
    }));
}

export function createToolSearchTools(services: ToolSearchServices): ToolContract<any>[] {
  const env = () => services.env ?? process.env;
  const isOn = () =>
    services.isEnabled?.() ??
    resolveDiscoveryEnabled(services.settingsStore, env());

  const toolSearch: ToolContract<{ query: string; limit?: number }> = {
    name: 'tool_search',
    description:
      'Search authorized local tools by name, capability group or keyword. Automatically load up to 5 matches for the next turn without executing them. External capability cards, when enabled, are informational and loaded by id separately.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    },
    approvalMode: 'never',
    sideEffectLevel: 'system',
    async execute(ctx, args): Promise<ToolExecutionResult> {
      const discoveryOn = isOn();
      const budget = Math.min(5, Math.max(1, toolDisclosureBudget(env())));
      const limit = Math.min(
        Number.isFinite(args.limit) && (args.limit as number) > 0 ? Math.floor(Number(args.limit)) : budget,
        budget
      );
      const query = String(args.query ?? '');
      const deferred = deferredToolHits(hiddenOnDemandTools(ctx, services), query, limit);

      const capability = discoveryOn
        ? searchBoundCapabilities(services.getRegistry(), query, limit).map((hit) => ({
            ...hit,
            source: 'capability' as const
          }))
        : [];
      const loaded: string[] = [];
      const failures: Array<{name:string;reason:string}> = [];
      for(const hit of deferred) {
        try {
          if(!services.discloseTool || !ctx.session?.id) throw new Error('Tool loading is unavailable');
          services.discloseTool(ctx.session.id,hit.name); loaded.push(hit.name);
        } catch(error) { failures.push({name:hit.name,reason:error instanceof Error?error.message:'Load failed'}); }
      }
      const hits = [...deferred, ...capability].slice(0,limit);
      return {
        ok: failures.length === 0,
        content: JSON.stringify({ budget, count: hits.length, hits, loaded, failures, status: failures.length?'load_failed':hits.length?'matched':'no_match', externalDiscoveryEnabled: discoveryOn }, null, 2)
      };
    }
  };

  const loadTool: ToolContract<{ id?: string; name?: string }> = {
    name: 'load_capability_tool',
    description:
      'Load a bound capability by id, or disclose a hidden on-demand tool by name so it can be called on the next step. Passing name does not require capability discovery to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'system',
    async execute(ctx, args): Promise<ToolExecutionResult> {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (name) {
        const hidden = hiddenOnDemandTools(ctx, services);
        const sessionId = ctx.session?.id;
        const disclose = services.discloseTool;
        if (!hidden.some((tool) => tool.name === name) || !disclose || !sessionId) {
          return { ok: false, content: `Cannot load tool ${name}.` };
        }
        try { disclose(sessionId, name); }
        catch(error) { return {ok:false,content:JSON.stringify({status:'load_failed',name,reason:error instanceof Error?error.message:'Load failed'})}; }
        return { ok: true, content: `${name} can be called on the next step.` };
      }
      if (!isOn()) {
        return { ok: false, content: DISCOVERY_DISABLED };
      }
      const id = String(args.id ?? '').trim();
      if (!id) return { ok: false, content: 'id is required' };
      if (toolLoadStrict(env())) {
        const sessionId = ctx.session?.id ?? '';
        const shortlist = services.getShortlist?.(sessionId) ?? [];
        if (!shortlist.includes(id)) {
          return {
            ok: false,
            content: JSON.stringify({
              error: 'strict_load_denied',
              message: 'Capability id not in session shortlist (RAW_AGENT_TOOL_LOAD_STRICT=1)'
            })
          };
        }
      }
      const card = services.getRegistry().get(id);
      if (!card) return { ok: false, content: `Capability not found: ${id}` };
      if (card.trust !== 'bound') {
        return { ok: false, content: `Capability ${id} is not bound (trust=${card.trust})` };
      }
      const bindings = services.getRegistry().listBindings(id);
      return {
        ok: true,
        content: JSON.stringify(
          {
            id: card.id,
            name: card.name,
            description: card.description,
            kind: card.kind,
            endpoint: card.endpoint,
            schemaRef: card.schemaRef,
            schemaHash: card.schemaHash,
            scope: card.scope,
            cbom: card.cbom,
            metadata: card.metadata,
            bindings
          },
          null,
          2
        )
      };
    }
  };

  return [toolSearch, loadTool];
}
