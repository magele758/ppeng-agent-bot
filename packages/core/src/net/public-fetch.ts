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
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

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
  /**
   * Per-address connect deadline. A silent address is abandoned so the next
   * approved address can be tried. The caller abort signal still stops failover.
   * After response headers this deadline is cleared, but the caller abort stays
   * armed until the body is read or cancelled. Default 10s. Not an environment switch.
   */
  connectTimeoutMs?: number;
}

export interface PublicFetchInit extends PublicFetchDeps {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** When false, a 3xx response is returned instead of followed. Default follows. */
  followRedirects?: boolean;
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

function connectTimeoutMs(init: PublicFetchInit): number {
  return init.connectTimeoutMs && init.connectTimeoutMs > 0 ? init.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
}

interface ConnectAttempt {
  signal: AbortSignal;
  /** Headers arrived. Drop only the connect timer; caller abort stays linked. */
  clearConnectTimer(): void;
  /** Connection failed, the body was cancelled, or the body finished. */
  dispose(): void;
}

/**
 * Per-address deadline. A plain `AbortSignal.timeout` is unref'd, so a silent
 * socket would never expire when this fetch is the only pending work.
 * `clearConnectTimer` must not detach the caller abort: body reads still need it.
 */
function connectDeadline(parent: AbortSignal, ms: number): ConnectAttempt {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error('connect timed out');
    error.name = 'AbortError';
    controller.abort(error);
  }, ms);
  const onParent = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onParent, { once: true });
  let disposed = false;
  return {
    signal: controller.signal,
    clearConnectTimer() {
      clearTimeout(timer);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    }
  };
}

/**
 * Keep `parent` wired to the socket until the body ends, errors, or is cancelled.
 * Clearing that link when the headers arrive leaves a stalled body unread forever.
 */
function retainCallerAbort(response: Response, parent: AbortSignal, dispose: () => void): Response {
  const body = response.body;
  if (!body) {
    dispose();
    return response;
  }
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    parent.removeEventListener('abort', onAbort);
    dispose();
  };
  const onAbort = () => {
    void reader.cancel(abortError(parent)).catch(() => undefined);
  };
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort);
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (parent.aborted) {
        const reason = abortError(parent);
        release();
        await reader.cancel(reason).catch(() => undefined);
        controller.error(reason);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (parent.aborted) {
          const reason = abortError(parent);
          release();
          controller.error(reason);
          return;
        }
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error instanceof Error ? error : new Error(String(error)));
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    }
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function shouldFollowRedirect(response: Response, followRedirects: boolean | undefined): boolean {
  return response.status >= 300 && response.status < 400 && followRedirects !== false;
}

/**
 * GET/HEAD with manual redirects. Every hop is rechecked.
 * Each attempt is pinned to one approved address and has its own connect deadline.
 * A connection failure or a silent address tries the next approved address.
 * An abort from the caller does not. After headers, that abort stays armed until
 * the body is read or cancelled; only the connect timer is cleared.
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
    let attempt: ConnectAttempt | undefined;
    const connectMs = connectTimeoutMs(init);
    for (const address of addresses) {
      if (init.signal.aborted) throw abortError(init.signal);
      const currentAttempt = connectDeadline(init.signal, connectMs);
      try {
        response = await request(current, address, {
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          body: init.body,
          signal: currentAttempt.signal
        });
        currentAttempt.clearConnectTimer();
        attempt = currentAttempt;
        break;
      } catch (err) {
        currentAttempt.dispose();
        if (init.signal.aborted) throw isAbortError(err, init.signal) ? err : abortError(init.signal);
        lastError = err;
      }
    }
    if (!response || !attempt) {
      throw lastError instanceof Error ? lastError : new Error('connect failed');
    }
    if (init.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      attempt.dispose();
      throw abortError(init.signal);
    }
    const redirect = shouldFollowRedirect(response, init.followRedirects);
    const settled = attempt;
    if (!redirect) return retainCallerAbort(response, init.signal, () => settled.dispose());
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    attempt.dispose();
    if (!location || hop === max) throw new Error('Redirect limit exceeded');
    current = new URL(location, current);
  }
  throw new Error('Redirect limit exceeded');
}
