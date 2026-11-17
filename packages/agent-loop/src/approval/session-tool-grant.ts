/**
 * Session-scoped "always allow this kind" grants.
 * Kind = tool name + sandbox isolation mode. One session only.
 */

export const SESSION_TOOL_GRANT_KEY = 'sessionToolGrants';

const MAX_GRANTS = 32;
const SHELL_TOOLS = new Set(['bash', 'bg_run', 'work_evidence']);
const SHELL_MODES = new Set(['os', 'direct', 'remote', 'container']);
const KNOWN_ISOLATION = new Set(['auto', 'os', 'direct', 'remote', 'container', 'unspecified', 'unknown']);
const AUTO_TOKENS = new Set(['', 'auto', 'default', 'strongest']);
const ALIASES: Record<string, string> = {
  auto: 'auto',
  default: 'auto',
  strongest: 'auto',
  os: 'os',
  direct: 'direct',
  remote: 'remote',
  'cloudflare-computer': 'remote',
  'cf-computer': 'remote',
  container: 'container',
  docker: 'container',
  podman: 'container'
};

export interface SessionToolGrant {
  toolName: string;
  isolation: string;
}

export interface PendingLike {
  id: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  status: string;
}

export function isolationModeOf(toolName: string, args: unknown): string {
  if (SHELL_TOOLS.has(toolName)) return shellIsolation(readIsolation(args));
  return 'unspecified';
}

export function readSessionToolGrants(metadata: Record<string, unknown> | undefined): SessionToolGrant[] {
  return normalizeSessionToolGrants(metadata?.[SESSION_TOOL_GRANT_KEY]);
}

export function normalizeSessionToolGrants(raw: unknown): SessionToolGrant[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SessionToolGrant[] = [];
  for (const item of raw) {
    pushGrant(out, seen, item);
    if (out.length >= MAX_GRANTS) break;
  }
  return out;
}

export function addSessionToolGrant(
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown
): SessionToolGrant[] {
  const list = metadata?.[SESSION_TOOL_GRANT_KEY];
  const current = Array.isArray(list) ? list : [];
  return normalizeSessionToolGrants([...current, { toolName, isolation: isolationModeOf(toolName, args) }]);
}

export function sessionGrantCovers(
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown,
  latestStatus?: string
): boolean {
  if (latestStatus === 'rejected') return false;
  const isolation = isolationModeOf(toolName, args);
  return readSessionToolGrants(metadata).some((grant) => sameGrant(grant, toolName, isolation));
}

export function approvalStillRequired(
  toolWantsApproval: boolean,
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown,
  latestStatus?: string
): boolean {
  if (!toolWantsApproval) return false;
  return !sessionGrantCovers(metadata, toolName, args, latestStatus);
}

export function settlePending(
  waiting: boolean,
  cite: () => void,
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown
): boolean {
  if (sessionGrantCovers(metadata, toolName, args)) return waiting;
  cite();
  return true;
}

export function settleRequireCard(
  waiting: boolean,
  open: () => void,
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown,
  latestStatus?: string
): boolean {
  if (sessionGrantCovers(metadata, toolName, args, latestStatus)) return waiting;
  open();
  return true;
}

export function callsNotCoveredBySessionGrant<T extends { name: string; input: unknown }>(
  calls: readonly T[],
  metadata: Record<string, unknown> | undefined
): T[] {
  return calls.filter((call) => keepUngranted(call, metadata));
}

export function otherPendingCovered(
  items: readonly PendingLike[],
  currentId: string,
  sessionId: string,
  toolName: string,
  args: unknown
): string[] {
  const isolation = isolationModeOf(toolName, args);
  return items.filter((item) => coveredSibling(item, currentId, sessionId, toolName, isolation)).map((item) => item.id);
}

function keepUngranted(call: { name: string; input: unknown }, metadata: Record<string, unknown> | undefined): boolean {
  return !sessionGrantCovers(metadata, call.name, call.input);
}

function sameGrant(grant: SessionToolGrant, toolName: string, isolation: string): boolean {
  return grant.toolName === toolName && grant.isolation === isolation;
}

function coveredSibling(
  item: PendingLike,
  currentId: string,
  sessionId: string,
  toolName: string,
  isolation: string
): boolean {
  if (item.status !== 'pending' || item.id === currentId) return false;
  if (item.sessionId !== sessionId || item.toolName !== toolName) return false;
  return isolationModeOf(item.toolName, item.args) === isolation;
}

function pushGrant(out: SessionToolGrant[], seen: Set<string>, item: unknown): void {
  const grant = parseGrant(item);
  if (!grant) return;
  const key = `${grant.toolName}\0${grant.isolation}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(grant);
}

function parseGrant(item: unknown): SessionToolGrant | null {
  const fields = recordFields(item);
  if (!fields) return null;
  const toolName = fields.toolName.trim();
  const isolation = canonicalIsolation(fields.isolation);
  if (!acceptableToolName(toolName) || !isolation) return null;
  return { toolName, isolation };
}

function recordFields(item: unknown): { toolName: string; isolation: string } | null {
  if (!isRecord(item)) return null;
  if (typeof item.toolName !== 'string') return null;
  if (typeof item.isolation !== 'string') return null;
  return { toolName: item.toolName, isolation: item.isolation };
}

function acceptableToolName(toolName: string): boolean {
  return toolName.length > 0 && !toolName.includes('*');
}

function canonicalIsolation(raw: string): string | null {
  const token = raw.trim().toLowerCase().replace(/_/g, '-');
  if (token === '') return null;
  if (AUTO_TOKENS.has(token)) return 'auto';
  if (KNOWN_ISOLATION.has(token)) return token;
  const alias = ALIASES[token];
  if (!alias) return null;
  return alias;
}

function shellIsolation(raw: string | null): string {
  if (raw == null) return 'auto';
  const token = raw.trim().toLowerCase().replace(/_/g, '-');
  if (AUTO_TOKENS.has(token)) return 'auto';
  if (SHELL_MODES.has(token)) return token;
  const alias = ALIASES[token];
  if (alias) return alias;
  return 'unknown';
}

function readIsolation(args: unknown): string | null {
  if (!isRecord(args)) return null;
  if (typeof args.isolation !== 'string') return null;
  return args.isolation;
}

function isRecord(item: unknown): item is Record<string, unknown> {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
}
