import { ValidationError } from '../errors.js';
import { resolveDomainSelection } from './effective-config.js';
import type { DomainBundle } from '../domain.js';
import type { ToolContract } from '../types.js';

export const RUNTIME_CAPABILITIES_KEY = 'runtime_capabilities';
export const DOMAIN_CATALOG_KEY = 'runtime_domain_catalog';
interface Store {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}
export interface DomainCapability {
  id: string;
  label: string;
  tools: string[];
  skills: string[];
  agents: string[];
}
export interface RuntimeCapabilities { a2uiEnabled: boolean; domains: string[] }
type CapabilityKind = 'tools' | 'skills' | 'agents';

export function registerDomainCatalog(store: Store, bundles: DomainBundle[]) {
  store.setDaemonControl?.(DOMAIN_CATALOG_KEY, bundles.map(bundle => ({
    id: bundle.id,
    label: bundle.label,
    tools: bundle.tools.map(tool => tool.name),
    skills: (bundle.skills ?? []).map(skill => skill.id),
    agents: bundle.agents.map(agent => agent.id)
  })));
}

export function domainCatalog(store: Store): DomainCapability[] {
  return (store.getDaemonControl?.(DOMAIN_CATALOG_KEY) as DomainCapability[] | undefined) ?? [];
}

export function readRuntimeCapabilities(store: Store, env: NodeJS.ProcessEnv = process.env): RuntimeCapabilities {
  const saved = store.getDaemonControl?.(RUNTIME_CAPABILITIES_KEY) as Partial<RuntimeCapabilities> | undefined;
  return {
    a2uiEnabled: saved?.a2uiEnabled ?? /^(1|true|yes)$/i.test(env.RAW_AGENT_A2UI_ENABLED?.trim() ?? ''),
    domains: saved?.domains ?? resolveDomainSelection(env).ids
  };
}

export function writeRuntimeCapabilities(store: Store, raw: Record<string, unknown>): RuntimeCapabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Expected a settings object');
  const patch: Partial<RuntimeCapabilities> = {};
  if ('a2uiEnabled' in raw) {
    if (typeof raw.a2uiEnabled !== 'boolean') throw new ValidationError('a2uiEnabled must be boolean');
    patch.a2uiEnabled = raw.a2uiEnabled;
  }
  if ('domains' in raw) {
    const known = new Set(domainCatalog(store).map(domain => domain.id));
    if (!Array.isArray(raw.domains) || raw.domains.some(id => typeof id !== 'string' || !known.has(id))) {
      throw new ValidationError('Unknown domain');
    }
    patch.domains = [...new Set(raw.domains as string[])];
  }
  const previous = store.getDaemonControl?.(RUNTIME_CAPABILITIES_KEY) as Partial<RuntimeCapabilities> | undefined;
  store.setDaemonControl?.(RUNTIME_CAPABILITIES_KEY, { ...previous, ...patch });
  return readRuntimeCapabilities(store);
}

/** Read one configuration snapshot per catalog, rather than querying SQLite for every entry. */
export function runtimeCapabilityCheck(store: Store | undefined, env: NodeJS.ProcessEnv = process.env) {
  const settings = readRuntimeCapabilities(store ?? {}, env);
  const catalog = domainCatalog(store ?? {});
  return (kind: CapabilityKind, id: string): boolean => {
    if (kind === 'tools' && (id === 'a2ui_render' || id === 'a2ui_delete_surface')) return settings.a2uiEnabled;
    const owner = catalog.find(domain => domain[kind].includes(id));
    return !owner || settings.domains.includes(owner.id);
  };
}

export function runtimeCapabilityEnabled(store: Store | undefined, kind: CapabilityKind, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeCapabilityCheck(store, env)(kind, id);
}

/** Kept references, including PTC tools, must respect a later disable before dispatch. */
export function guardRuntimeCapability(store: Store, tool: ToolContract<any>): ToolContract<any> {
  return {
    ...tool,
    execute: async (context, args) => {
      if (!runtimeCapabilityEnabled(store, 'tools', tool.name)) return { ok: false, content: 'Capability disabled in Lab settings' };
      return tool.execute(context, args);
    }
  };
}
