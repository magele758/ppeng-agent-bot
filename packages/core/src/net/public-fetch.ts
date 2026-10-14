/**
 * Shared public HTTP fetch for web_fetch, DeepResearch, images, and attachments.
 * Literal hosts and DNS answers go through the same private-address check.
 * Each redirect hop is checked again, and the socket is pinned to the approved address.
 */
import { lookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { requestApprovedAddress, type PinnedRequest } from '../connectors/http-request.js';
import { isBlockedVerifyHost, isPrivateOrReservedIp } from '../goal/run-verify.js';

export const PRIVATE_HOST_REFUSAL =
  'Refused: private/local host (set RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE=1 to allow)';

const MAX_REDIRECTS = 5;
const DEFAULT_DNS_TIMEOUT_MS = 10_000;

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
  /** DNS deadline. The caller abort signal also cancels lookup. Default 10s. */
  dnsTimeoutMs?: number;
}

export interface PublicFetchInit extends PublicFetchDeps {
  method?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function hextet(part: string | undefined): number {
  if (!part || !/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
  return Number.parseInt(part, 16);
}

function expandIpv6Hextets(address: string): string[] | undefined {
  let text = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  const dotted = text.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const octets = dotted[1].split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, text.length - dotted[1].length)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): string[] | undefined => {
    if (!side) return [];
    const parts = side.split(':');
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
    return parts;
  };
  const head = parseSide(halves[0] ?? '');
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseSide(halves[1] ?? '');
  if (!tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

function ipv4FromHextets(hi: string | undefined, lo: string | undefined): string | undefined {
  const high = hextet(hi);
  const low = hextet(lo);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return [(high >>> 8) & 255, high & 255, (low >>> 8) & 255, low & 255].join('.');
}

/** NAT64 64:ff9b::/96 and deprecated IPv4-compatible ::a.b.c.d, judged by the embedded IPv4. */
function blockedEmbeddedIpv6(address: string): boolean {
  if (!isIPv6(address)) return false;
  const hextets = expandIpv6Hextets(address);
  if (!hextets || hextets.length !== 8) return false;
  const nat64 = [0x64, 0xff9b, 0, 0, 0, 0].every((value, index) => hextet(hextets[index]) === value);
  const compatible = hextets.slice(0, 6).every((part) => hextet(part) === 0);
  if (!nat64 && !compatible) return false;
  const embedded = ipv4FromHextets(hextets[6], hextets[7]);
  if (!embedded) return true;
  return isBlockedFetchAddress(embedded);
}

/** Literal addresses and resolved answers. Hostnames also use the verify blocklist. */
export function isBlockedFetchAddress(address: string): boolean {
  const bare = bareHost(address);
  if (isPrivateOrReservedIp(bare)) return true;
  if (isBlockedVerifyHost(bare)) return true;
  const lower = bare.toLowerCase();
  if (lower === '::') return true;
  if (isIPv4(lower)) {
    const parts = lower.split('.').map((part) => Number(part));
    const first = parts[0] ?? Number.NaN;
    const second = parts[1] ?? Number.NaN;
    if (first === 198 && (second === 18 || second === 19)) return true;
    return Number.isFinite(first) && first >= 224;
  }
  return blockedEmbeddedIpv6(lower);
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/** Lookup stops when the caller aborts or the DNS deadline fires. The OS lookup itself may finish later. */
function resolveBounded(
  hostname: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<readonly string[]> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = AbortSignal.any([signal, timeout]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => {
        if (signal.aborted) reject(abortError(signal));
        else reject(new Error('DNS lookup timed out'));
      });
    };
    if (deadline.aborted) {
      onAbort();
      return;
    }
    deadline.addEventListener('abort', onAbort, { once: true });
    resolveHost(hostname).then(
      (addresses) => finish(() => resolve(addresses)),
      (err: unknown) => finish(() => reject(err))
    );
  });
}

/** Addresses the connection may use, in resolver order. Throws before any socket when one is private. */
async function approvedPublicAddresses(
  url: URL,
  deps: PublicFetchDeps,
  signal: AbortSignal
): Promise<readonly string[]> {
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
    const timeoutMs = deps.dnsTimeoutMs && deps.dnsTimeoutMs > 0 ? deps.dnsTimeoutMs : DEFAULT_DNS_TIMEOUT_MS;
    try {
      addresses = await resolveBounded(bare, deps.resolveHost ?? defaultResolveHost, signal, timeoutMs);
    } catch (err) {
      if (isAbortError(err, signal) || (err instanceof Error && err.message === 'DNS lookup timed out')) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`DNS lookup failed: ${reason}`);
    }
  }
  if (addresses.length === 0) throw new Error('DNS lookup failed: no addresses');
  if (!allow && addresses.some((address) => isBlockedFetchAddress(address))) throw new PrivateNetworkDenied();
  return addresses;
}

/**
 * GET/HEAD with manual redirects. Every hop is rechecked.
 * Each attempt is pinned to one approved address. A connection failure tries the next approved address.
 */
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
    if (init.signal.aborted) throw abortError(init.signal);
    const addresses = await approvedPublicAddresses(current, init, init.signal);
    let response: Response | undefined;
    let lastError: unknown;
    for (const address of addresses) {
      if (init.signal.aborted) throw abortError(init.signal);
      try {
        response = await request(current, address, {
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          signal: init.signal
        });
        break;
      } catch (err) {
        if (isAbortError(err, init.signal)) throw err;
        lastError = err;
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error('connect failed');
    }
    const redirect = response.status >= 300 && response.status < 400;
    if (!redirect) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || hop === max) throw new Error('Redirect limit exceeded');
    current = new URL(location, current);
  }
  throw new Error('Redirect limit exceeded');
}
