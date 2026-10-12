/** Shared helpers for Next → daemon `/api/*` proxy (middleware). */

export const LAB_PROXY_HEADER = 'x-ppeng-lab';

/** Keep in sync with `apps/daemon/src/human-release.ts`. */
export const HUMAN_RELEASE_HEADER = 'x-ppeng-human-release';

export function humanReleaseSecret(env: NodeJS.ProcessEnv): string {
  return String(env.RAW_AGENT_HUMAN_RELEASE_SECRET ?? '').trim();
}

/** Browser fetches from the Lab page set this. A bare curl does not. */
export function requestLooksLikeLabPage(headers: Headers): boolean {
  return headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Attach the human release secret on the daemon hop. The browser never sees it.
 * Only same-origin Lab page fetches qualify, so a model shell curling the Lab
 * port does not receive the header unless it forges `Sec-Fetch-Site`.
 */
export function applyHumanReleaseHeader(requestHeaders: Headers, outbound: Headers, env: NodeJS.ProcessEnv): void {
  const secret = humanReleaseSecret(env);
  if (!secret || !requestLooksLikeLabPage(requestHeaders)) return;
  if (outbound.get(HUMAN_RELEASE_HEADER)?.trim()) return;
  outbound.set(HUMAN_RELEASE_HEADER, secret);
}

const HOP_BY_HOP = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
] as const;

export function sanitizeProxyHeaders(src: Headers): Headers {
  const headers = new Headers(src);
  for (const name of HOP_BY_HOP) headers.delete(name);
  return headers;
}

/** Copy daemon response headers, preserving multiple Set-Cookie values. */
export function copyProxyResponseHeaders(res: Headers): Headers {
  const headers = sanitizeProxyHeaders(res);
  const getSetCookie = (res as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    headers.delete('set-cookie');
    for (const cookie of getSetCookie.call(res)) {
      headers.append('set-cookie', cookie);
    }
  }
  return headers;
}

export function daemonProxyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error && err.cause
        ? String(err.cause)
        : '';
  return cause ? `${message} (${cause})` : message;
}
