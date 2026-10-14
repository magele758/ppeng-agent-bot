import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  ANONYMOUS_AUTH,
  AuthStore,
  buildAuthorizeUrl,
  canAccessSession,
  filterSessionsByAuth,
  hashToken,
  OAUTH_PUBLIC_ORIGIN_REQUIRED,
  oauthNonLocalNeedsPublicOrigin,
  oauthPublicConfig,
  oauthPublicOrigin,
  oauthStartupNeedsPublicOrigin,
  stampOwnerMetadata,
  upsertUserFromOAuth
} from '../dist/auth/index.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { authRoutes } from '../../../apps/daemon/dist/routes/auth.js';
import { requestPublicOrigin, requestSecure } from '../../../apps/daemon/dist/user-auth.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

test('oauthPublicConfig: loginRequired only when a provider pair is complete', () => {
  assert.deepEqual(oauthPublicConfig({}), { loginRequired: false, providers: [] });
  assert.equal(
    oauthPublicConfig({
      RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID: 'id',
      RAW_AGENT_OAUTH_GOOGLE_CLIENT_SECRET: 'secret'
    }).loginRequired,
    true
  );
  assert.deepEqual(
    oauthPublicConfig({ RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID: 'id-only' }).providers,
    []
  );
});

test('buildAuthorizeUrl: google includes PKCE, github includes user email scope', () => {
  const google = buildAuthorizeUrl({
    provider: { id: 'google', clientId: 'g-id', clientSecret: 'g-sec' },
    redirectUri: 'http://127.0.0.1:33815/api/auth/google/callback',
    state: 'st',
    codeChallenge: 'chal'
  });
  assert.match(google, /accounts\.google\.com/);
  assert.match(google, /code_challenge=chal/);
  const github = buildAuthorizeUrl({
    provider: { id: 'github', clientId: 'gh-id', clientSecret: 'gh-sec' },
    redirectUri: 'http://127.0.0.1:33815/api/auth/github/callback',
    state: 'st'
  });
  assert.match(github, /github\.com\/login\/oauth\/authorize/);
  assert.match(github, /user%3Aemail/);
});

test('upsertUserFromOAuth: same email links google then github', () => {
  const store = tempStore();
  const memory = store.agentMemory();
  const auth = new AuthStore(store.db);
  const first = upsertUserFromOAuth({
    memory,
    auth,
    profile: {
      provider: 'google',
      providerUserId: 'g1',
      email: 'a@example.com',
      displayName: 'Ada'
    },
    env: { RAW_AGENT_DEFAULT_TENANT_ID: 't1' }
  });
  const second = upsertUserFromOAuth({
    memory,
    auth,
    profile: {
      provider: 'github',
      providerUserId: '42',
      email: 'a@example.com',
      displayName: 'ada-gh'
    },
    env: { RAW_AGENT_DEFAULT_TENANT_ID: 't1' }
  });
  assert.equal(first.id, second.id);
  assert.ok(auth.getIdentity('google', 'g1'));
  assert.ok(auth.getIdentity('github', '42'));
  store.db.close();
});

test('upsertUserFromOAuth: first tenant member becomes owner; re-login keeps promoted roles', () => {
  const store = tempStore();
  const memory = store.agentMemory();
  const auth = new AuthStore(store.db);
  const env = { RAW_AGENT_DEFAULT_TENANT_ID: 't1' };
  const login = (id) =>
    upsertUserFromOAuth({ memory, auth, profile: { provider: 'github', providerUserId: id, email: `${id}@example.com` }, env });
  const roleOf = (userId) => memory.getMemberships(userId).find((m) => m.tenantId === 't1')?.role;

  const first = login('u1');
  const second = login('u2');
  assert.equal(roleOf(first.id), 'owner');
  assert.equal(roleOf(second.id), 'member');

  memory.addMembership({ userId: second.id, tenantId: 't1', role: 'admin' });
  login('u2');
  login('u1');
  assert.equal(roleOf(second.id), 'admin');
  assert.equal(roleOf(first.id), 'owner');
  store.db.close();
});

test('auth sessions: hash lookup then expiry purge', () => {
  const store = tempStore();
  const auth = new AuthStore(store.db);
  const token = 'plain-session-token';
  auth.createAuthSession({
    tokenHash: hashToken(token),
    userId: 'user_1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  });
  assert.equal(auth.getAuthSession(hashToken(token))?.userId, 'user_1');
  auth.deleteAuthSession(hashToken(token));
  assert.equal(auth.getAuthSession(hashToken(token)), undefined);
  store.db.close();
});

test('filterSessionsByAuth hides other owners when isolating', () => {
  const auth = {
    isolate: true,
    labProxy: true,
    user: { id: 'u1', tenantId: 'default' }
  };
  const sessions = [
    { id: 'a', metadata: { userId: 'u1' } },
    { id: 'b', metadata: { userId: 'u2' } },
    { id: 'c', metadata: {} }
  ];
  assert.deepEqual(
    filterSessionsByAuth(sessions, auth).map((s) => s.id),
    ['a']
  );
  assert.equal(canAccessSession(sessions[1], auth), false);
  assert.equal(canAccessSession(sessions[0], ANONYMOUS_AUTH), true);
  assert.deepEqual(stampOwnerMetadata({ title: 'x' }, auth).userId, 'u1');
});

test('oauthPublicOrigin trusts only the configured origin, else loopback', () => {
  assert.equal(
    oauthPublicOrigin(
      { RAW_AGENT_OAUTH_PUBLIC_ORIGIN: 'https://lab.example/' },
      'https://evil.example'
    ),
    'https://lab.example'
  );
  assert.equal(oauthPublicOrigin({}, '127.0.0.1:27070'), 'http://127.0.0.1:27070');
  assert.equal(oauthPublicOrigin({}, 'http://localhost:23000/ignored'), 'http://localhost:23000');
  assert.equal(oauthPublicOrigin({}, '[::1]:37070'), 'http://[::1]:37070');
  assert.equal(oauthPublicOrigin({}, 'evil.example'), '');
  assert.equal(oauthPublicOrigin({}, 'https://evil.example'), '');
  assert.equal(oauthPublicOrigin({}, 'localhost.evil.com'), '');
  assert.equal(oauthPublicOrigin({}, 'https://user:pass@127.0.0.1'), '');
});

function oauthEnv() {
  return {
    RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID: 'id',
    RAW_AGENT_OAUTH_GOOGLE_CLIENT_SECRET: 'secret'
  };
}

function startGoogle(env, headers) {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-origin-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: dir,
    modelAdapter: {
      name: 'noop',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const spec = authRoutes({ runtime, authStore: new AuthStore(runtime.store.db), env }).find(
    (route) => route.method === 'GET' && route.pattern === '/api/auth/google/start'
  );
  assert.ok(spec);
  let location;
  let body = '';
  const response = {
    statusCode: 200,
    setHeader(name, value) {
      if (String(name).toLowerCase() === 'location') location = value;
    },
    appendHeader() {},
    end(text) {
      if (text) body += text;
    }
  };
  spec.handler({
    request: { headers, url: '/api/auth/google/start' },
    response,
    url: new URL('http://127.0.0.1/api/auth/google/start'),
    parts: ['api', 'auth', 'google', 'start'],
    params: {},
    requireParam: () => '',
    readBody: async () => ({}),
    auth: ANONYMOUS_AUTH
  });
  runtime.store.db.close();
  return { status: response.statusCode, location, body };
}

test('OAuth start ignores forged Host and X-Forwarded-Host when public origin is unset', () => {
  const forged = {
    host: 'evil.example',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https'
  };
  assert.equal(oauthStartupNeedsPublicOrigin(oauthEnv()), true);
  assert.equal(oauthStartupNeedsPublicOrigin({
    ...oauthEnv(),
    RAW_AGENT_OAUTH_PUBLIC_ORIGIN: 'https://lab.example'
  }), false);
  assert.equal(oauthNonLocalNeedsPublicOrigin(oauthEnv(), ['evil.example', '127.0.0.1:27070']), true);
  assert.equal(oauthNonLocalNeedsPublicOrigin({}, ['127.0.0.1:27070', 'localhost:23000']), false);
  assert.equal(requestPublicOrigin({ headers: forged }, {}), '');
  assert.equal(requestSecure({ headers: forged }, {}), false);
  const started = startGoogle(oauthEnv(), forged);
  assert.equal(started.status, 400);
  assert.equal(started.location, undefined);
  assert.match(started.body, /RAW_AGENT_OAUTH_PUBLIC_ORIGIN/);
  assert.match(started.body, new RegExp(OAUTH_PUBLIC_ORIGIN_REQUIRED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(started.body, /evil\.example/);

  const loopbackHeaders = {
    host: '127.0.0.1:27070',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https'
  };
  assert.equal(requestPublicOrigin({ headers: loopbackHeaders }, {}), 'http://127.0.0.1:27070');
  assert.equal(requestSecure({ headers: loopbackHeaders }, {}), false);
  const proxied = startGoogle(oauthEnv(), loopbackHeaders);
  assert.equal(proxied.status, 400);
  assert.equal(proxied.location, undefined);
  assert.match(proxied.body, /RAW_AGENT_OAUTH_PUBLIC_ORIGIN/);
  assert.doesNotMatch(proxied.body, /evil\.example/);

  const local = startGoogle(oauthEnv(), { host: '127.0.0.1:27070' });
  assert.equal(local.status, 302);
  assert.match(local.location, /^https:\/\/accounts\.google\.com\//);
  assert.match(local.location, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A27070%2Fapi%2Fauth%2Fgoogle%2Fcallback/);

  const localLab = startGoogle(oauthEnv(), {
    host: '127.0.0.1:27070',
    'x-forwarded-host': '127.0.0.1:23000',
    'x-forwarded-proto': 'http'
  });
  assert.equal(localLab.status, 302);
  assert.match(localLab.location, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A27070%2Fapi%2Fauth%2Fgoogle%2Fcallback/);
  assert.doesNotMatch(localLab.location, /23000/);

  const configured = {
    ...oauthEnv(),
    RAW_AGENT_OAUTH_PUBLIC_ORIGIN: 'https://lab.example'
  };
  assert.equal(requestPublicOrigin({ headers: forged }, configured), 'https://lab.example');
  assert.equal(requestSecure({ headers: forged }, configured), true);
  const remote = startGoogle(configured, forged);
  assert.equal(remote.status, 302);
  assert.match(remote.location, /redirect_uri=https%3A%2F%2Flab\.example%2Fapi%2Fauth%2Fgoogle%2Fcallback/);
  assert.doesNotMatch(remote.location, /evil\.example/);
});
