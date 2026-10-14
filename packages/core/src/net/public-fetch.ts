/**
 * Shared public HTTP fetch for web_fetch, DeepResearch, images, and attachments.
 * Literal hosts and DNS answers go through the same private-address check.
 * Each redirect hop is checked again, and the socket is pinned to the approved address.
 */
import { lookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
import { requestApprovedAddress, type PinnedRequest } from '../connectors/http-request.js';
import { isBlockedVerifyHost, isPrivateOrReservedIp } from '../goal/run-verify.js';

export const PRIVATE_HOST_REFUSAL =
  'Refused: private/local host (set RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE=1 to allow)';

const MAX_REDIRECTS = 5;

export class PrivateNetworkDenied extends Error {
  readonly code = 'private_network';

  constructor(message = PRIVATE_HOST_REFUSAL) {
    super(message);
    this.name = 'PrivateNetworkDenied';
  }
}

export function webFetchAllowsPrivate(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes'].includes(String(env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE ?? '').toLowerCase());
}

export interface PublicFetchDeps {
  allowPrivateHosts?: boolean;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  request?: (url: URL, address: string, options: PinnedRequest) => Promise<Response>;
  maxRedirects?: number;
}

export interface PublicFetchInit extends PublicFetchDeps {
  method?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Literal addresses and resolved answers. Hostnames also use the verify blocklist. */
export function isBlockedFetchAddress(address: string): boolean {
  const bare = bareHost(address);
  if (isPrivateOrReservedIp(bare)) return true;
  if (isBlockedVerifyHost(bare)) return true;
  const lower = bare.toLowerCase();
  if (lower === '::') return true;
  if (isIPv4(lower)) {
    const first = Number(lower.split('.')[0]);
    return Number.isFinite(first) && first >= 224;
  }
  return false;
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/** Address the connection must use. Throws before any socket when the target is private. */
export async function approvedPublicAddress(url: URL, deps: PublicFetchDeps = {}): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const bare = bareHost(url.hostname);
  if (!bare) throw new PrivateNetworkDenied();
  const allow = deps.allowPrivateHosts === true;
  if (!allow && isBlockedFetchAddress(bare)) throw new PrivateNetworkDenied();
  let addresses: readonly string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    try {
      addresses = await (deps.resolveHost ?? defaultResolveHost)(bare);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`DNS lookup failed: ${reason}`);
    }
  }
  if (addresses.length === 0) throw new Error('DNS lookup failed: no addresses');
  if (!allow && addresses.some((address) => isBlockedFetchAddress(address))) throw new PrivateNetworkDenied();
  const chosen = addresses[0];
  if (!chosen) throw new PrivateNetworkDenied();
  return chosen;
}

/** GET/HEAD with manual redirects. Every hop is rechecked and pinned. */
export async function fetchPinnedPublic(rawUrl: string, init: PublicFetchInit): Promise<Response> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  const request = init.request ?? requestApprovedAddress;
  const max = init.maxRedirects ?? MAX_REDIRECTS;
  for (let hop = 0; hop <= max; hop += 1) {
    const address = await approvedPublicAddress(current, init);
    const response = await request(current, address, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      signal: init.signal
    });
    const redirect = response.status >= 300 && response.status < 400;
    if (!redirect) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || hop === max) throw new Error('Redirect limit exceeded');
    current = new URL(location, current);
  }
  throw new Error('Redirect limit exceeded');
}
