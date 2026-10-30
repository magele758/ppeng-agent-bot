/**
 * Lab connector authorization dialogue.
 * Grant posts a SecretVault name (secretEnv) — never a secret value.
 */

export type ConnectorAuthState = 'needsAuth' | 'needsGrant' | 'granted';

export interface ConnectorWire {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  authKind?: unknown;
  secretEnv?: unknown;
  credRef?: unknown;
  granted?: unknown;
  authState?: unknown;
}

export interface ConnectorView {
  id: string;
  title: string;
  source: string;
  authKind: string;
  secretEnv?: string;
  credRef?: string;
  granted: boolean;
  authState: ConnectorAuthState;
}

export interface SecretName {
  name: string;
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set<ConnectorAuthState>(['needsAuth', 'needsGrant', 'granted']);

export function connectorAuthState(input: {
  granted: boolean;
  authKind: string;
  secretEnv?: string;
  credRef?: string;
}): ConnectorAuthState {
  if (input.granted) return 'granted';
  if (input.authKind && input.authKind !== 'none' && !input.secretEnv && !input.credRef) return 'needsAuth';
  return 'needsGrant';
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function connectorView(row: ConnectorWire): ConnectorView | undefined {
  const id = text(row.id);
  if (!id) return undefined;
  const secretEnv = text(row.secretEnv);
  const credRef = text(row.credRef);
  const authKind = text(row.authKind) ?? 'none';
  const granted = row.granted === true;
  const hinted = text(row.authState);
  const authState = hinted && STATES.has(hinted as ConnectorAuthState)
    ? (hinted as ConnectorAuthState)
    : connectorAuthState({ granted, authKind, ...(secretEnv ? { secretEnv } : {}), ...(credRef ? { credRef } : {}) });
  return {
    id,
    title: text(row.title) ?? id,
    source: text(row.source) ?? 'plugin',
    authKind,
    ...(secretEnv ? { secretEnv } : {}),
    ...(credRef ? { credRef } : {}),
    granted,
    authState
  };
}

export function connectorViews(payload: { connectors?: unknown } | null | undefined): ConnectorView[] {
  const list = Array.isArray(payload?.connectors) ? payload.connectors : [];
  return list.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const view = connectorView(row as ConnectorWire);
    return view ? [view] : [];
  });
}

export function secretNames(payload: { secrets?: unknown } | null | undefined): SecretName[] {
  const list = Array.isArray(payload?.secrets) ? payload.secrets : [];
  const names: SecretName[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const name = row && typeof row === 'object' ? text((row as { name?: unknown }).name) : undefined;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push({ name });
  }
  return names.sort((a, b) => a.name.localeCompare(b.name));
}

/** Body for POST /api/connectors/:id/grant. Names only — never a secret value. */
export function grantReferenceBody(row: ConnectorView, pickedName?: string): { secretEnv?: string; credRef?: string } {
  if (row.authState === 'needsAuth') {
    const name = (pickedName ?? '').trim();
    if (!ENV_NAME_RE.test(name)) throw new Error('secretEnv must be a SecretVault name');
    return { secretEnv: name };
  }
  const picked = (pickedName ?? '').trim();
  if (picked && ENV_NAME_RE.test(picked) && picked !== row.secretEnv) return { secretEnv: picked };
  if (row.secretEnv) return { secretEnv: row.secretEnv };
  if (row.credRef) return { credRef: row.credRef };
  return {};
}

export function defaultGrantName(row: ConnectorView, secrets: readonly SecretName[]): string {
  if (row.secretEnv && secrets.some((item) => item.name === row.secretEnv)) return row.secretEnv;
  if (row.secretEnv && ENV_NAME_RE.test(row.secretEnv)) return row.secretEnv;
  return secrets[0]?.name ?? '';
}

/** POST /api/connectors/:id/grant. Names only — never a secret value. */
export async function postConnectorGrant(
  row: ConnectorView,
  pickedName: string | undefined,
  post: (path: string, body: { secretEnv?: string; credRef?: string }) => Promise<unknown>
): Promise<void> {
  const body = grantReferenceBody(row, pickedName);
  await post(`/api/connectors/${encodeURIComponent(row.id)}/grant`, body);
}

