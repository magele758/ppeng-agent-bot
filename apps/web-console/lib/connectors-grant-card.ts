/**
 * In-chat face for a connector that still needs a SecretVault grant.
 * The card names the connector and the vault entry. It never carries a secret value.
 */

import { connectorView, grantReferenceBody, type ConnectorView, type ConnectorWire } from './connectors-grant.ts';

export type ConnectorGrantCardFace = {
  id: string;
  title: string;
  authState: 'needsAuth' | 'needsGrant';
  secretEnv?: string;
  credRef?: string;
  row: ConnectorView;
};

function wireOf(source: Record<string, unknown>): ConnectorWire {
  return {
    id: source.id,
    title: source.title,
    source: source.source,
    authKind: source.authKind,
    secretEnv: source.secretEnv,
    credRef: source.credRef,
    granted: source.granted,
    authState: source.authState
  };
}

function openGrantState(state: ConnectorView['authState']): 'needsAuth' | 'needsGrant' | undefined {
  if (state === 'needsAuth' || state === 'needsGrant') return state;
  return undefined;
}

function withRef(row: ConnectorView, face: ConnectorGrantCardFace): ConnectorGrantCardFace {
  return {
    ...face,
    ...(row.secretEnv ? { secretEnv: row.secretEnv } : {}),
    ...(row.credRef ? { credRef: row.credRef } : {})
  };
}

function faceFromRow(row: ConnectorView | undefined): ConnectorGrantCardFace | null {
  const authState = row ? openGrantState(row.authState) : undefined;
  if (!row || !authState) return null;
  return withRef(row, { id: row.id, title: row.title, authState, row });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function cardRecord(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  return root ? asRecord(root.card) : undefined;
}

/** Tool-result card. Granted rows and secret values do not become a face. */
export function connectorGrantResultCard(content: string): ConnectorGrantCardFace | null {
  const row = cardRecord(content);
  if (!row || row.kind !== 'connector_grant') return null;
  return faceFromRow(connectorView(wireOf(row)));
}

/** Approval-queue card. Same face, read from the pending tool args. */
export function connectorGrantApprovalCard(approval: {
  toolName: string;
  args?: Record<string, unknown>;
}): ConnectorGrantCardFace | null {
  if (approval.toolName !== 'connector_grant') return null;
  return faceFromRow(connectorView(wireOf(approval.args ?? {})));
}

/** POST /api/connectors/:id/grant body. A SecretVault name only — never a secret value. */
export function connectorGrantCardBody(face: ConnectorGrantCardFace, pickedName?: string) {
  return grantReferenceBody(face.row, pickedName);
}
