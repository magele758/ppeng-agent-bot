import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AUTH_OAUTH_STATE_COOKIE,
  AuthStore,
  buildAuthorizeUrl,
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchOAuthProfile,
  hashToken,
  OAUTH_PUBLIC_ORIGIN_REQUIRED,
  createLogger,
  oauthCallbackPath,
  oauthProvider,
  oauthPublicConfig,
  oauthStateCookieHeader,
  publicAuthUser,
  randomUrlToken,
  readCookie,
  readSessionToken,
  sessionCookieHeader,
  sessionTtlMs,
  upsertUserFromOAuth,
  type AgentMemoryStore,
  type OAuthProviderId,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { oauthOriginBlocked, requestPublicOrigin, requestSecure } from '../user-auth.js';

const oauthLog = createLogger('oauth');

function nowIso(): string {
  return new Date().toISOString();
}

function appendCookie(response: ServerResponse<IncomingMessage>, cookie: string): void {
  response.appendHeader('set-cookie', cookie);
}

function redirect(response: ServerResponse<IncomingMessage>, location: string): void {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.end();
}

function startRoute(
  provider: OAuthProviderId,
  env: NodeJS.ProcessEnv,
  authStore: AuthStore
): RouteSpec {
  return {
    method: 'GET',
    pattern: `/api/auth/${provider}/start`,
    handler: ({ request, response }) => {
      const cfg = oauthProvider(env, provider);
      if (!cfg) {
        json(response, 404, { error: 'OAuth provider is not configured' });
        return;
      }
      const origin = requestPublicOrigin(request, env);
      if (!origin || oauthOriginBlocked(request, env)) {
        oauthLog.warn(OAUTH_PUBLIC_ORIGIN_REQUIRED);
        json(response, 400, { error: OAUTH_PUBLIC_ORIGIN_REQUIRED });
        return;
      }
      const state = randomUrlToken(24);
      const pkce = provider === 'google' ? createPkcePair() : undefined;
      authStore.purgeExpired();
      authStore.putOAuthState({
        state,
        provider,
        codeVerifier: pkce?.verifier,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        createdAt: nowIso()
      });
      const redirectUri = `${origin}${oauthCallbackPath(provider)}`;
      const url = buildAuthorizeUrl({
        provider: cfg,
        redirectUri,
        state,
        codeChallenge: pkce?.challenge
      });
      appendCookie(response, oauthStateCookieHeader(state, requestSecure(request, env)));
      redirect(response, url);
    }
  };
}

function callbackRoute(
  provider: OAuthProviderId,
  env: NodeJS.ProcessEnv,
  authStore: AuthStore,
  memory: AgentMemoryStore
): RouteSpec {
  return {
    method: 'GET',
    pattern: `/api/auth/${provider}/callback`,
    handler: async ({ request, response, url }) => {
      const origin = requestPublicOrigin(request, env) || '/';
      const home = origin.endsWith('/') ? origin : `${origin}/`;
      const fail = (code: string) => {
        appendCookie(response, clearOAuthStateCookieHeader(requestSecure(request, env)));
        redirect(response, `${home}?auth_error=${encodeURIComponent(code)}`);
      };
      const cfg = oauthProvider(env, provider);
      if (!cfg) {
        fail('failed');
        return;
      }
      if (url.searchParams.get('error')) {
        fail('denied');
        return;
      }
      const code = url.searchParams.get('code')?.trim() ?? '';
      const state = url.searchParams.get('state')?.trim() ?? '';
      const cookieState = readCookie(request.headers, AUTH_OAUTH_STATE_COOKIE);
      if (!code || !state || !cookieState || cookieState !== state) {
        fail('failed');
        return;
      }
      const stored = authStore.takeOAuthState(state);
      if (!stored || stored.provider !== provider) {
        fail('failed');
        return;
      }
      try {
        const redirectUri = `${origin.replace(/\/$/, '')}${oauthCallbackPath(provider)}`;
        const accessToken = await exchangeAuthorizationCode({
          provider: cfg,
          redirectUri,
          code,
          codeVerifier: stored.codeVerifier
        });
        const profile = await fetchOAuthProfile({ provider, accessToken });
        const user = upsertUserFromOAuth({ memory, auth: authStore, profile, env });
        const token = randomUrlToken(32);
        authStore.createAuthSession({
          tokenHash: hashToken(token),
          userId: user.id,
          expiresAt: new Date(Date.now() + sessionTtlMs()).toISOString(),
          createdAt: nowIso()
        });
        const secure = requestSecure(request, env);
        appendCookie(response, sessionCookieHeader(token, secure));
        appendCookie(response, clearOAuthStateCookieHeader(secure));
        redirect(response, home);
      } catch {
        fail('failed');
      }
    }
  };
}

export function authRoutes(params: {
  runtime: RawAgentRuntime;
  authStore: AuthStore;
  env: NodeJS.ProcessEnv;
}): RouteSpec[] {
  const { runtime, authStore, env } = params;
  const memory = runtime.store.agentMemory();

  return [
    {
      method: 'GET',
      pattern: '/api/auth/me',
      handler: ({ response, auth }) => {
        const cfg = oauthPublicConfig(env);
        json(response, 200, {
          loginRequired: cfg.loginRequired,
          providers: cfg.providers,
          user: auth.user ? publicAuthUser(auth.user) : null
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/auth/logout',
      handler: ({ request, response }) => {
        const raw = readSessionToken(request.headers);
        if (raw) authStore.deleteAuthSession(hashToken(raw));
        appendCookie(response, clearSessionCookieHeader(requestSecure(request, env)));
        json(response, 200, { ok: true });
      }
    },
    startRoute('google', env, authStore),
    startRoute('github', env, authStore),
    callbackRoute('google', env, authStore, memory),
    callbackRoute('github', env, authStore, memory)
  ];
}
