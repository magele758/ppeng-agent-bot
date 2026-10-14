import { isIPv4 } from 'node:net';
import type { OAuthProviderConfig, OAuthProviderId, OAuthPublicConfig } from './types.js';

function pair(
  env: NodeJS.ProcessEnv,
  id: OAuthProviderId,
  idKey: string,
  secretKey: string
): OAuthProviderConfig | undefined {
  const clientId = String(env[idKey] ?? '').trim();
  const clientSecret = String(env[secretKey] ?? '').trim();
  if (!clientId || !clientSecret) return undefined;
  return { id, clientId, clientSecret };
}

export function oauthProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthProviderConfig[] {
  const out: OAuthProviderConfig[] = [];
  const google = pair(
    env,
    'google',
    'RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID',
    'RAW_AGENT_OAUTH_GOOGLE_CLIENT_SECRET'
  );
  const github = pair(
    env,
    'github',
    'RAW_AGENT_OAUTH_GITHUB_CLIENT_ID',
    'RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET'
  );
  if (google) out.push(google);
  if (github) out.push(github);
  return out;
}

export function oauthProvider(
  env: NodeJS.ProcessEnv,
  id: OAuthProviderId
): OAuthProviderConfig | undefined {
  return oauthProvidersFromEnv(env).find((p) => p.id === id);
}

export function oauthPublicConfig(env: NodeJS.ProcessEnv = process.env): OAuthPublicConfig {
  const providers = oauthProvidersFromEnv(env).map((p) => p.id);
  return { loginRequired: providers.length > 0, providers };
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[+|\]+$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (!isIPv4(host)) return false;
  return Number(host.split('.')[0]) === 127;
}

/** Unconfigured origins may only be loopback http. Client-supplied hosts are not trusted. */
function loopbackHttpOrigin(fallbackHost: string | undefined): string {
  const raw = (fallbackHost ?? '').trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`);
  } catch {
    return '';
  }
  if (url.username || url.password) return '';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!isLoopbackHostname(url.hostname)) return '';
  return `http://${url.host}`;
}

export function oauthPublicOrigin(env: NodeJS.ProcessEnv, fallbackHost?: string): string {
  const explicit = String(env.RAW_AGENT_OAUTH_PUBLIC_ORIGIN ?? '')
    .trim()
    .replace(/\/$/, '');
  if (explicit) return explicit;
  return loopbackHttpOrigin(fallbackHost);
}
