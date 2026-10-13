import { SoftwareExecution } from './software-execution.js';
import type { RunContext, ToolExecutionResult } from '../types.js';
/**
 * Per-connector grant registry.
 *
 * Plugins, bound discovery cards, and mounted domain packs share one record.
 * Grant stores a secret env name or credential reference — never the secret
 * value. Ungranted connectors stay out of the tool list and the prompt.
 * Domain tools stay on the daemon's static mount; this registry only lists them.
 */

import { ValidationError, NotFoundError } from '../errors.js';
import type { CapabilityCard, CapabilityTrust } from '../discovery/types.js';
import type { LoadedPlugin, PluginAuthKind, PluginToolDecl } from '../plugins/plugin-loader.js';
import { assertWritableEnvName, isReservedEnvName } from '../secrets/reserved-env-names.js';
import type { ToolContract } from '../types.js';

export const CONNECTOR_GRANTS_KEY = 'connector_grants';

export type ConnectorSource = 'plugin' | 'discovery' | 'domain';
export type ConnectorAuthKind = PluginAuthKind;

export interface ConnectorRecord {
  id: string;
  title: string;
  source: ConnectorSource;
  instructions: string;
  authKind: ConnectorAuthKind;
  secretEnv?: string;
  credRef?: string;
  granted: boolean;
}

/** Wire shape. Instructions and secret values are omitted. */
export interface ConnectorPublic {
  id: string;
  title: string;
  source: ConnectorSource;
  authKind: ConnectorAuthKind;
  secretEnv?: string;
  credRef?: string;
  granted: boolean;
}

export interface DomainConnectorSource {
  id: string;
  title: string;
  instructions?: string;
  authKind?: ConnectorAuthKind;
  secretEnv?: string;
  credRef?: string;
}

export interface ConnectorGrantStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

interface StoredGrant {
  secretEnv?: string;
  credRef?: string;
}

export interface ConnectorRegistryDeps {
  store: ConnectorGrantStore;
  getPlugins: () => readonly LoadedPlugin[];
  getCapabilities?: () => readonly CapabilityCard[];
  getDomains?: () => readonly DomainConnectorSource[];
}

const CRED_REF_RE = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeEnvName(name: string | undefined): string | undefined {
  if (!name || !ENV_NAME_RE.test(name) || isReservedEnvName(name)) return undefined;
  return name;
}

export function pluginConnectorId(manifestId: string): string {
  return `plugin:${manifestId}`;
}

export function discoveryConnectorId(cardId: string): string {
  return `discovery:${cardId}`;
}

export function domainConnectorId(domainId: string): string {
  return `domain:${domainId}`;
}

/**
 * Discovery injection rule. Untrusted cards that have not been granted never
 * enter the prompt or the tool list. Trust transitions stay on the capability
 * registry — a grant does not bind a card, and only a bound card can be injected.
 */
export function shouldInjectDiscovery(trust: CapabilityTrust, granted: boolean): boolean {
  if (trust === 'untrusted' && !granted) return false;
  if (trust !== 'bound') return false;
  return granted;
}

function readGrants(store: ConnectorGrantStore): Record<string, StoredGrant> {
  const raw = store.getDaemonControl<unknown>(CONNECTOR_GRANTS_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StoredGrant> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const grant: StoredGrant = {};
    if (typeof row.secretEnv === 'string') grant.secretEnv = row.secretEnv;
    if (typeof row.credRef === 'string') grant.credRef = row.credRef;
    out[id] = grant;
  }
  return out;
}

function safeCredRef(
  credRef: string | undefined,
  env: NodeJS.ProcessEnv,
  secretEnv?: string
): string | undefined {
  if (!credRef || !CRED_REF_RE.test(credRef)) return undefined;
  if (secretEnv) {
    const named = env[secretEnv];
    if (typeof named === 'string' && named.length > 0 && named === credRef) return undefined;
  }
  for (const value of Object.values(env)) {
    if (typeof value === 'string' && value.length >= 8 && value === credRef) return undefined;
  }
  return credRef;
}

function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

function secretValues(records: readonly ConnectorRecord[], env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const record of records) {
    if (!record.secretEnv) continue;
    const value = env[record.secretEnv];
    if (typeof value === 'string' && value.length >= 8) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function parseGrant(input: unknown, env: NodeJS.ProcessEnv): StoredGrant {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('grant body must be an object');
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'secretEnv' && key !== 'credRef') {
      throw new ValidationError('grant only accepts secretEnv or credRef');
    }
  }
  const grant: StoredGrant = {};
  if ('secretEnv' in rec && rec.secretEnv != null) {
    if (typeof rec.secretEnv !== 'string') throw new ValidationError('secretEnv must be an env name');
    try {
      assertWritableEnvName(rec.secretEnv);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
    grant.secretEnv = rec.secretEnv;
  }
  if ('credRef' in rec && rec.credRef != null) {
    if (typeof rec.credRef !== 'string') throw new ValidationError('credRef must be a reference name');
    if (!safeCredRef(rec.credRef, env, grant.secretEnv)) {
      throw new ValidationError('credRef must be a reference name, not a secret value');
    }
    grant.credRef = rec.credRef;
  }
  return grant;
}

function compose(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function projectPlugin(
  plugin: LoadedPlugin,
  grant: StoredGrant | undefined,
  env: NodeJS.ProcessEnv
): ConnectorRecord {
  const secretEnv = safeEnvName(grant?.secretEnv ?? plugin.secretEnv);
  const credRef = safeCredRef(grant?.credRef, env, secretEnv);
  const instructions = compose([
    plugin.instructionText,
    plugin.authKind !== 'none' ? `Auth kind: ${plugin.authKind}` : '',
    secretEnv ? `Secret env name: ${secretEnv}` : '',
    plugin.headerName ? `Header name: ${plugin.headerName}` : '',
    credRef ? `Credential reference: ${credRef}` : ''
  ]);
  return {
    id: pluginConnectorId(plugin.manifest.id),
    title: plugin.manifest.name,
    source: 'plugin',
    instructions,
    authKind: plugin.authKind,
    ...(secretEnv ? { secretEnv } : {}),
    ...(credRef ? { credRef } : {}),
    granted: grant !== undefined
  };
}

function projectDiscovery(
  card: CapabilityCard,
  grant: StoredGrant | undefined,
  env: NodeJS.ProcessEnv
): ConnectorRecord | undefined {
  if (card.trust !== 'bound') return undefined;
  const secretEnv = safeEnvName(grant?.secretEnv);
  const credRef = safeCredRef(grant?.credRef ?? card.credRef, env, secretEnv);
  const instructions = compose([
    card.description,
    `Capability ${card.name} (${card.kind}) is bound.`,
    'Use tool_search, then load_capability_tool, before calling it.',
    card.endpoint ? `Endpoint: ${safeEndpoint(card.endpoint)}` : '',
    card.scope.length ? `Scope: ${card.scope.join(', ')}` : '',
    credRef ? `Credential reference: ${credRef}` : ''
  ]);
  return {
    id: discoveryConnectorId(card.id),
    title: card.name,
    source: 'discovery',
    instructions,
    authKind: credRef || secretEnv ? 'bearer' : 'none',
    ...(secretEnv ? { secretEnv } : {}),
    ...(credRef ? { credRef } : {}),
    granted: grant !== undefined
  };
}

function projectDomain(
  domain: DomainConnectorSource,
  grant: StoredGrant | undefined,
  env: NodeJS.ProcessEnv
): ConnectorRecord {
  const secretEnv = safeEnvName(grant?.secretEnv ?? domain.secretEnv);
  const credRef = safeCredRef(grant?.credRef ?? domain.credRef, env, secretEnv);
  return {
    id: domainConnectorId(domain.id),
    title: domain.title,
    source: 'domain',
    instructions: compose([domain.instructions]),
    authKind: domain.authKind ?? 'none',
    ...(secretEnv ? { secretEnv } : {}),
    ...(credRef ? { credRef } : {}),
    granted: grant !== undefined
  };
}

function redactRecord(record: ConnectorRecord, secrets: readonly string[]): ConnectorRecord {
  return {
    ...record,
    title: redactSecrets(record.title, secrets),
    instructions: redactSecrets(record.instructions, secrets)
  };
}

function toolFromDecl(decl: PluginToolDecl, connectorId: string, secrets: readonly string[]): ToolContract {
  let inputSchema = decl.inputSchema;
  try {
    inputSchema = JSON.parse(redactSecrets(JSON.stringify(decl.inputSchema), secrets)) as Record<
      string,
      unknown
    >;
  } catch {
    inputSchema = { type: 'object', properties: {} };
  }
  return {
    name: decl.name,
    description: redactSecrets(decl.description, secrets),
    inputSchema,
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute() {
      return {
        ok: false,
        content: `Connector ${connectorId} tool ${decl.name} is granted but has no host executor.`
      };
    }
  };
}

export function mergeGrantedConnectorTools<T extends { name: string }>(
  catalog: T[],
  granted: readonly T[],
  previouslyInjected: ReadonlySet<string>
): Set<string> {
  const injected = new Set<string>();
  const grantedByName = new Map<string, T>();
  for (const tool of granted) {
    if (!tool.name || grantedByName.has(tool.name)) continue;
    grantedByName.set(tool.name, tool);
  }
  for (const [name, tool] of grantedByName) {
    const index = catalog.findIndex((item) => item.name === name);
    if (index >= 0) {
      if (previouslyInjected.has(name)) {
        catalog[index] = tool;
        injected.add(name);
      }
      continue;
    }
    catalog.push(tool);
    injected.add(name);
  }
  for (let i = catalog.length - 1; i >= 0; i -= 1) {
    const name = catalog[i]!.name;
    if (previouslyInjected.has(name) && !injected.has(name)) catalog.splice(i, 1);
  }
  return injected;
}

export class ConnectorRegistry {
  private domains: readonly DomainConnectorSource[] | undefined;

  readonly software: SoftwareExecution;
  constructor(private readonly deps: ConnectorRegistryDeps) { this.software = new SoftwareExecution(deps.store); }
  bindSoftware(principal: string, botId: string, connectorId: string, input: unknown) {
    return this.software.bind(principal, botId, connectorId, this.softwareBindingInput(connectorId, input));
  }
  softwareBindingInput(connectorId: string, input: unknown): Record<string, unknown> {
    const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (Array.isArray(body.tools)) return body;
    const plugin = this.deps.getPlugins().find(p => pluginConnectorId(p.manifest.id) === connectorId);
    const card = this.capabilities().find(c => discoveryConnectorId(c.id) === connectorId && c.trust === 'bound');
    const tools = plugin?.toolDecls ?? card?.metadata?.draftTools;
    if (!Array.isArray(tools)) throw new ValidationError('No executable declarations; provide tools or import OpenAPI');
    const executableTools = tools.map((tool: PluginToolDecl) => {
      const executor = tool.executor;
      if (plugin?.authKind === 'oauth') throw new ValidationError('OAuth plugin executors are unsupported');
      if (!executor || executor.kind !== 'http' || executor.auth || !plugin || plugin.authKind === 'none') return tool;
      return { ...tool, executor: { ...executor, auth: plugin.authKind === 'bearer' ? {kind:'bearer' as const} : {kind:'header' as const, name:plugin.headerName ?? 'X-API-Key'} } };
    });
    return { ...(plugin?.secretEnv ? {secretEnv:plugin.secretEnv}:{}), ...body, tools: executableTools };
  }
  setMcpInvoker(fn: (name: string, args: Record<string, unknown>, ctx: RunContext) => Promise<ToolExecutionResult>): void {this.software.setMcpInvoker(fn);}

  /** Display-only domain rows. Does not mount or unmount domain tools. */
  setDomains(domains: readonly DomainConnectorSource[]): void {
    this.domains = domains;
  }

  listConnectors(env: NodeJS.ProcessEnv = process.env): ConnectorRecord[] {
    const grants = readGrants(this.deps.store);
    const secrets = secretValues(this.rawRecords(grants, env), env);
    return this.rawRecords(grants, env).map((record) => redactRecord(record, secrets));
  }

  listPublic(env: NodeJS.ProcessEnv = process.env): ConnectorPublic[] {
    return this.listConnectors(env).map((record) => this.toPublic(record, env));
  }

  toPublic(record: ConnectorRecord, env: NodeJS.ProcessEnv = process.env): ConnectorPublic {
    const secrets = secretValues([record], env);
    const credRef = safeCredRef(record.credRef, env, record.secretEnv);
    return {
      id: record.id,
      title: redactSecrets(record.title, secrets),
      source: record.source,
      authKind: record.authKind,
      ...(record.secretEnv ? { secretEnv: record.secretEnv } : {}),
      ...(credRef ? { credRef } : {}),
      granted: record.granted
    };
  }

  grantConnector(id: string, input?: unknown, env: NodeJS.ProcessEnv = process.env): ConnectorRecord {
    const known = this.listConnectors(env).some((record) => record.id === id);
    if (!known) throw new NotFoundError('Connector', id);
    const grant = parseGrant(input, env);
    const grants = readGrants(this.deps.store);
    grants[id] = grant;
    this.deps.store.setDaemonControl(CONNECTOR_GRANTS_KEY, grants);
    const next = this.listConnectors(env).find((record) => record.id === id);
    if (!next) throw new NotFoundError('Connector', id);
    return next;
  }

  revokeConnector(id: string, env: NodeJS.ProcessEnv = process.env): ConnectorRecord {
    const known = this.listConnectors(env).some((record) => record.id === id);
    if (!known) throw new NotFoundError('Connector', id);
    const grants = readGrants(this.deps.store);
    delete grants[id];
    this.deps.store.setDaemonControl(CONNECTOR_GRANTS_KEY, grants);
    const next = this.listConnectors(env).find((record) => record.id === id);
    if (!next) throw new NotFoundError('Connector', id);
    return next;
  }

  /** Prompt fragment for granted connectors. Empty when nothing is granted. */
  instructionsForGranted(env: NodeJS.ProcessEnv = process.env): string {
    const blocks = this.injectable(env)
      .map((record) => record.instructions.trim())
      .filter(Boolean);
    if (blocks.length === 0) return '';
    return ['## Connector instructions', ...blocks].join('\n\n');
  }

  /** Plugin tools for granted connectors. Domain mounts are not included. */
  toolsForGranted(env: NodeJS.ProcessEnv = process.env): ToolContract[] {
    const grants = readGrants(this.deps.store);
    const records = this.rawRecords(grants, env);
    const secrets = secretValues(records, env);
    const grantedPlugins = new Set(
      records.filter((record) => record.source === 'plugin' && record.granted).map((record) => record.id)
    );
    const tools: ToolContract[] = [];
    const seen = new Set<string>();
    for (const plugin of this.deps.getPlugins()) {
      const id = pluginConnectorId(plugin.manifest.id);
      if (!grantedPlugins.has(id)) continue;
      for (const decl of plugin.toolDecls) {
        if (seen.has(decl.name)) continue;
        seen.add(decl.name);
        tools.push(toolFromDecl(decl, id, secrets));
      }
    }
    const bound = this.software.tools();
    const overrides = new Map(bound.map(t => [t.name, t]));
    return [...tools.filter(t => !overrides.has(t.name)), ...bound];
  }

  private injectable(env: NodeJS.ProcessEnv): ConnectorRecord[] {
    const grants = readGrants(this.deps.store);
    const cards = new Map(this.capabilities().map((card) => [discoveryConnectorId(card.id), card]));
    return this.listConnectors(env).filter((record) => {
      if (!record.granted) return false;
      if (record.source !== 'discovery') return true;
      const card = cards.get(record.id);
      if (!card) return false;
      return shouldInjectDiscovery(card.trust, record.granted);
    });
  }

  private rawRecords(grants: Record<string, StoredGrant>, env: NodeJS.ProcessEnv): ConnectorRecord[] {
    const records: ConnectorRecord[] = [];
    const seen = new Set<string>();
    const push = (record: ConnectorRecord | undefined) => {
      if (!record || seen.has(record.id)) return;
      seen.add(record.id);
      records.push(record);
    };
    for (const plugin of this.deps.getPlugins()) {
      if (!plugin.manifest.id) continue;
      const id = pluginConnectorId(plugin.manifest.id);
      push(projectPlugin(plugin, grants[id], env));
    }
    for (const card of this.capabilities()) {
      const id = discoveryConnectorId(card.id);
      push(projectDiscovery(card, grants[id], env));
    }
    for (const domain of this.domainSources()) {
      if (!domain.id) continue;
      const id = domainConnectorId(domain.id);
      push(projectDomain(domain, grants[id], env));
    }
    return records;
  }

  private capabilities(): CapabilityCard[] {
    try {
      return [...(this.deps.getCapabilities?.() ?? [])];
    } catch {
      return [];
    }
  }

  private domainSources(): readonly DomainConnectorSource[] {
    if (this.domains) return this.domains;
    try {
      return this.deps.getDomains?.() ?? [];
    } catch {
      return [];
    }
  }
}

export function createConnectorRegistry(deps: ConnectorRegistryDeps): ConnectorRegistry {
  return new ConnectorRegistry(deps);
}

export function listConnectors(
  registry: ConnectorRegistry,
  env?: NodeJS.ProcessEnv
): ConnectorRecord[] {
  return registry.listConnectors(env);
}

export function grantConnector(
  registry: ConnectorRegistry,
  id: string,
  input?: unknown,
  env?: NodeJS.ProcessEnv
): ConnectorRecord {
  return registry.grantConnector(id, input, env);
}

export function revokeConnector(
  registry: ConnectorRegistry,
  id: string,
  env?: NodeJS.ProcessEnv
): ConnectorRecord {
  return registry.revokeConnector(id, env);
}

export function instructionsForGranted(registry: ConnectorRegistry, env?: NodeJS.ProcessEnv): string {
  return registry.instructionsForGranted(env);
}
