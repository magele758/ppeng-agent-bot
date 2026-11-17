import type { MessageKey } from './i18n/messages/types.ts';

/** Display copy of the session grant kind. Server rule lives in agent-loop session-tool-grant. */
const SHELL_TOOLS = new Set(['bash', 'bg_run', 'work_evidence']);
const SHELL_MODES = new Set(['os', 'direct', 'remote', 'container']);
const AUTO_TOKENS = new Set(['', 'auto', 'default', 'strongest']);
const ALIASES: Record<string, string> = {
  os: 'os',
  direct: 'direct',
  remote: 'remote',
  'cloudflare-computer': 'remote',
  'cf-computer': 'remote',
  container: 'container',
  docker: 'container',
  podman: 'container'
};

const LABEL_KEYS = {
  auto: 'tasks.inbox.isolationAuto',
  os: 'tasks.inbox.isolationOs',
  direct: 'tasks.inbox.isolationDirect',
  remote: 'tasks.inbox.isolationRemote',
  container: 'tasks.inbox.isolationContainer',
  unspecified: 'tasks.inbox.isolationUnspecified',
  unknown: 'tasks.inbox.isolationUnknown'
} as const satisfies Record<string, MessageKey>;

export interface SessionToolGrant {
  toolName: string;
  isolation: string;
}

export interface SessionGrantRow {
  sessionId: string;
  title: string;
  toolName: string;
  isolation: string;
  remaining: SessionToolGrant[];
}

export function isolationModeOf(toolName: string, args: unknown): string {
  if (SHELL_TOOLS.has(toolName)) return shellIsolation(readIsolation(args));
  return 'unspecified';
}

export function isolationLabel(mode: string, t: (key: MessageKey) => string): string {
  const key = LABEL_KEYS[mode as keyof typeof LABEL_KEYS];
  return key ? t(key) : mode;
}

export function isolationClass(mode: string): string {
  return mode === 'direct' ? 'console-iso console-iso--direct' : 'console-iso';
}

export function readSessionToolGrants(metadata: unknown): SessionToolGrant[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const raw = (metadata as { sessionToolGrants?: unknown }).sessionToolGrants;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(grantItem);
}

export function grantsWithout(grants: readonly SessionToolGrant[], toolName: string, isolation: string): SessionToolGrant[] {
  return grants.filter((grant) => grant.toolName !== toolName || grant.isolation !== isolation);
}

export function sessionGrantRows(sessions: readonly { id: string; title?: string; metadata?: unknown }[]): SessionGrantRow[] {
  const rows: SessionGrantRow[] = [];
  for (const session of sessions) {
    pushSessionRows(rows, session);
  }
  return rows;
}

export function approvalPostInit(sessionGrant: boolean): { method: 'POST'; headers: { 'Content-Type': string }; body: string } {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionGrant ? { sessionGrant: true } : {})
  };
}

function pushSessionRows(rows: SessionGrantRow[], session: { id: string; title?: string; metadata?: unknown }): void {
  const grants = readSessionToolGrants(session.metadata);
  for (const grant of grants) {
    rows.push({
      sessionId: session.id,
      title: session.title || session.id,
      toolName: grant.toolName,
      isolation: grant.isolation,
      remaining: grantsWithout(grants, grant.toolName, grant.isolation)
    });
  }
}

function grantItem(item: unknown): SessionToolGrant[] {
  const rec = grantRecord(item);
  if (!rec) return [];
  if (typeof rec.toolName !== 'string' || typeof rec.isolation !== 'string') return [];
  return [{ toolName: rec.toolName, isolation: rec.isolation }];
}

function grantRecord(item: unknown): { toolName?: unknown; isolation?: unknown } | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  return item as { toolName?: unknown; isolation?: unknown };
}

function shellIsolation(raw: string | null): string {
  if (raw == null) return 'auto';
  const token = raw.trim().toLowerCase().replace(/_/g, '-');
  if (AUTO_TOKENS.has(token)) return 'auto';
  if (SHELL_MODES.has(token)) return token;
  return ALIASES[token] ?? 'unknown';
}

function readIsolation(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as { isolation?: unknown }).isolation;
  if (typeof value !== 'string') return null;
  return value;
}
