import type { IncomingMessage } from 'node:http';
import { oauthPublicConfig, tokensEqual, type RequestAuth } from '@ppeng/agent-core';

/**
 * Human proof for draft approve/reject. Keep the header name in sync with
 * `apps/web-console/lib/daemon-proxy.ts`.
 *
 * A Lab login session is enough. Otherwise the request must carry
 * `RAW_AGENT_HUMAN_RELEASE_SECRET` in `x-ppeng-human-release`. The daemon
 * bearer is not that secret: model shells never inherit either value, and
 * bearer-only calls fail even when auth isolation is off. When Lab login is
 * on, a session cookie is required and the header cannot bypass it.
 * If neither a session nor a release secret is configured, the route fails closed.
 */
export const HUMAN_RELEASE_HEADER = 'x-ppeng-human-release';

export function humanReleaseSecret(env: NodeJS.ProcessEnv): string {
  return String(env.RAW_AGENT_HUMAN_RELEASE_SECRET ?? '').trim();
}

function headerValue(request: IncomingMessage): string {
  const header = request.headers[HUMAN_RELEASE_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw ?? '');
}

export function hasHumanRelease(request: IncomingMessage, env: NodeJS.ProcessEnv, auth: RequestAuth): boolean {
  if (auth.user) return true;
  if (oauthPublicConfig(env).loginRequired) return false;
  const secret = humanReleaseSecret(env);
  if (!secret) return false;
  return tokensEqual(headerValue(request), secret);
}
