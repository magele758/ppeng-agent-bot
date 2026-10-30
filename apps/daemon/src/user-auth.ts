import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AuthStore,
  authUserFromId,
  hashToken,
  LAB_PROXY_HEADER,
  isPublicHttpHost,
  oauthNonLocalNeedsPublicOrigin,
  oauthPublicConfig,
  oauthPublicOrigin,
  readSessionToken,
  type AgentMemoryStore,
  type AuthUser,
  type RequestAuth
} from '@ppeng/agent-core';
import { hasDaemonBearer } from './auth.js';
import { json } from './http-utils.js';

const ADMIN_ROLES = new Set(['owner', 'admin']);

const PUBLIC_PATHS = new Set(['/api/health', '/api/readiness', '/api/version']);

export function isLabProxyRequest(request: IncomingMessage): boolean {
  const header = request.headers[LAB_PROXY_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  return String(raw ?? '').trim() === '1';
}

export function isAuthPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) return true;
  // The share id is the capability. Library create/list/update stay behind login.
  return /^\/api\/pages\/share\/[^/]+$/.test(pathname);
}

export function requestPublicOrigin(request: IncomingMessage, env: NodeJS.ProcessEnv): string {
  const explicit = oauthPublicOrigin(env);
  if (explicit) return explicit;
  // Lab's proxy replaces Host with the daemon. A loopback X-Forwarded-Host is the
  // browser origin (including its port). Non-loopback values are not a callback origin.
  const forwarded = headerValue(request, 'x-forwarded-host');
  if (forwarded && !isPublicHttpHost(forwarded)) {
    const first = forwarded.split(',')[0]?.trim();
    const origin = oauthPublicOrigin(env, first);
    if (origin) return origin;
  }
  return oauthPublicOrigin(env, headerValue(request, 'host'));
}

export function requestSecure(request: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  return requestPublicOrigin(request, env).startsWith('https://');
}

/** True when this request is non-local and RAW_AGENT_OAUTH_PUBLIC_ORIGIN is unset. */
export function oauthOriginBlocked(request: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  return oauthNonLocalNeedsPublicOrigin(env, [
    headerValue(request, 'host'),
    headerValue(request, 'x-forwarded-host')
  ]);
}

function sessionUser(params: {
  request: IncomingMessage;
  env: NodeJS.ProcessEnv;
  memory: AgentMemoryStore;
  authStore: AuthStore;
}): AuthUser | null {
  const token = readSessionToken(params.request.headers);
  if (!token) return null;
  const row = params.authStore.getAuthSession(hashToken(token));
  return row ? authUserFromId(params.memory, row.userId, params.env) : null;
}

export function isTenantAdmin(memory: AgentMemoryStore, user: AuthUser | null): boolean {
  if (!user) return false;
  return memory
    .getMemberships(user.id)
    .some((m) => m.tenantId === user.tenantId && ADMIN_ROLES.has(String(m.role)));
}

/**
 * With Lab login configured every request is user-isolated unless it is an
 * operator call: no Lab proxy header plus the daemon bearer token. Omitting
 * the header alone never grants god mode (the Lab proxy always sets it).
 */
export function resolveRequestAuth(params: {
  request: IncomingMessage;
  env: NodeJS.ProcessEnv;
  memory: AgentMemoryStore;
  authStore: AuthStore;
}): RequestAuth {
  const labProxy = isLabProxyRequest(params.request);
  const operator = !labProxy && hasDaemonBearer(params.request, params.env);
  const isolate = oauthPublicConfig(params.env).loginRequired && !operator;
  const user = sessionUser(params);
  return { labProxy, isolate, user, admin: !isolate || isTenantAdmin(params.memory, user) };
}

export function requireLabLogin(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  env: NodeJS.ProcessEnv,
  auth: RequestAuth
): boolean {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (isAuthPublicPath(url.pathname)) return true;
  if (!auth.isolate || auth.user) return true;
  const cfg = oauthPublicConfig(env);
  json(response, 401, {
    error: 'login_required',
    loginRequired: true,
    providers: cfg.providers
  });
  return false;
}

export function headerValue(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? '').trim();
}
