import type { ChannelSpec } from '../types.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readNamedEnv(name: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const key = name?.trim();
  if (!key || !ENV_NAME.test(key)) return undefined;
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

/**
 * Resolve a header or config reference to a secret.
 * `env:NAME` and `$NAME` read that variable. A `Bearer` prefix is stripped for token use.
 */
export function resolveSecretToken(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const direct = trimmed.match(/^(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (direct?.[1]) return readNamedEnv(direct[1], env);
  const bearerEnv = trimmed.match(/^Bearer\s+(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (bearerEnv?.[1]) return readNamedEnv(bearerEnv[1], env);
  const bearer = trimmed.match(/^Bearer\s+(\S+)$/i);
  if (bearer?.[1]) return bearer[1];
  return trimmed;
}

/** Slack / Telegram bot token from `tokenEnv` or the Authorization header. Never log the return value. */
export function channelToken(channel: ChannelSpec, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = readNamedEnv(channel.tokenEnv, env);
  if (named) return named;
  return resolveSecretToken(headerValue(channel.headers, 'authorization'), env);
}

/** Header value for relays. `Bearer env:NAME` becomes `Bearer <secret>`. */
export function resolveHeaderValue(raw: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const direct = trimmed.match(/^(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (direct?.[1]) return readNamedEnv(direct[1], env);
  const bearerEnv = trimmed.match(/^Bearer\s+(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (bearerEnv?.[1]) {
    const token = readNamedEnv(bearerEnv[1], env);
    return token ? `Bearer ${token}` : undefined;
  }
  return raw;
}

/** Bot API tokens are interpolated into a URL path. Reject values that would change that path. */
export function tokenFitsUrlPath(token: string): boolean {
  return token.length > 0 && !/[\s/?#%\\@]/.test(token);
}
