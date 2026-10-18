import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppError, ValidationError, stampOwnerMetadata, tokensEqual, type RawAgentRuntime, type RequestAuth } from '@ppeng/agent-core';

const KEY = 'external_agent_settings';

export interface ExternalAgentClient {
  id: string;
  name: string;
  enabled: boolean;
  allowedAgentIds: string[];
  defaultAgentId: string;
  tokenHash: string;
  ownerMetadata: Record<string, unknown>;
}

interface ExternalAgentSettings {
  enabled: boolean;
  clients: ExternalAgentClient[];
}

export function readExternalAgentSettings(runtime: RawAgentRuntime): ExternalAgentSettings {
  return runtime.store.getDaemonControl<ExternalAgentSettings>(KEY) ?? { enabled: false, clients: [] };
}

export function publicExternalAgentSettings(settings: ExternalAgentSettings) {
  return {
    enabled: settings.enabled,
    clients: settings.clients.map(({ tokenHash, ownerMetadata: _owner, ...client }) => ({ ...client, tokenSet: Boolean(tokenHash) }))
  };
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected a JSON object');
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`);
  return value;
}

export function credentialHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function writeExternalAgentSettings(runtime: RawAgentRuntime, value: unknown, auth: RequestAuth) {
  const body = objectBody(value);
  const previous = readExternalAgentSettings(runtime);
  const enabled = booleanValue(body.enabled, previous.enabled, 'enabled');
  let clients = previous.clients;
  if (body.clients !== undefined) {
    if (!Array.isArray(body.clients) || body.clients.length > 100) throw new ValidationError('clients must be an array of at most 100 entries');
    const seenIds = new Set<string>();
    const seenHashes = new Set<string>();
    clients = body.clients.map(value => {
      const raw = objectBody(value);
      const id = requiredText(raw.id, 'id', 80);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || seenIds.has(id)) throw new ValidationError('Client IDs must be unique letters, digits, underscores or hyphens');
      seenIds.add(id);
      const old = previous.clients.find(client => client.id === id);
      const name = requiredText(raw.name, 'name', 160);
      if (!Array.isArray(raw.allowedAgentIds) || raw.allowedAgentIds.length === 0 || raw.allowedAgentIds.length > 100) {
        throw new ValidationError('allowedAgentIds must contain between 1 and 100 executor IDs');
      }
      const allowedAgentIds = [...new Set(raw.allowedAgentIds.map(id => requiredText(id, 'allowedAgentIds', 160)))];
      for (const id of allowedAgentIds) {
        if (!runtime.store.getAgent(id)) throw new ValidationError(`Unknown executor: ${id}`);
      }
      const defaultAgentId = requiredText(raw.defaultAgentId, 'defaultAgentId', 160);
      if (!allowedAgentIds.includes(defaultAgentId)) throw new ValidationError('defaultAgentId must be an allowed executor');
      let tokenHash = old?.tokenHash ?? '';
      if (raw.token !== undefined) {
        const token = requiredText(raw.token, 'token', 512);
        if (token.length < 32) throw new ValidationError('token must have at least 32 characters');
        tokenHash = credentialHash(token);
      }
      if (!tokenHash || seenHashes.has(tokenHash)) throw new ValidationError('Each client needs a unique credential');
      seenHashes.add(tokenHash);
      return { id, name, enabled: booleanValue(raw.enabled, true, 'client.enabled'), allowedAgentIds, defaultAgentId, tokenHash,
        ownerMetadata: old?.ownerMetadata ?? stampOwnerMetadata({}, auth) };
    });
  }
  const next = { enabled, clients };
  runtime.store.setDaemonControl(KEY, next);
  return publicExternalAgentSettings(next);
}

/** Independent scoped credentials; daemon operator tokens and Lab cookies confer no external access. */
export function authenticateExternalAgent(runtime: RawAgentRuntime, request: IncomingMessage): ExternalAgentClient {
  const settings = readExternalAgentSettings(runtime);
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const digest = credentialHash(token);
  const client = settings.clients.find(c => c.enabled && tokensEqual(c.tokenHash, digest));
  if (!settings.enabled || !token || !client) throw new AppError('UNAUTHENTICATED', 'Invalid external Agent credential or access disabled', 401);
  return client;
}

/** This exact namespace alone uses scoped external credentials instead of Lab login. */
export function isExternalAgentTaskPath(pathname: string): boolean {
  return /^\/api\/external-agent\/v1\/tasks(?:\/[^/]+)?$/.test(pathname);
}
