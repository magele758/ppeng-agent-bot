import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpHttpSession } from '../dist/mcp/mcp-http.js';
import { parseMcpHttpConfig } from '../dist/mcp/mcp-http-config.js';
import {
  MCP_OAUTH_AUTHORIZATION_PREFIX,
  McpOAuthClientProvider,
  finishMcpHttpOAuth
} from '../dist/mcp/mcp-oauth.js';

const WORKTREE = fileURLToPath(new URL('../../..', import.meta.url));
const MCP = 'http://127.0.0.1:9/mcp';
const ORIGIN = 'http://127.0.0.1:9';
const REDIRECT = 'http://127.0.0.1:37070/api/mcp/oauth/callback';
const ISSUED_ACCESS = 'issued-access-token';
const ISSUED_REFRESH = 'issued-refresh-token';

const INIT_RESULT = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: {} },
  serverInfo: { name: 'mock', version: '0' }
};

function s256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function bodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'object' && body && typeof body.toString === 'function') {
    const text = body.toString();
    if (text && text !== '[object Object]') return text;
  }
  return '';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function findNamed(dir, name, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findNamed(path, name, out);
    else if (entry.name === name) out.push(path);
  }
  return out;
}

function tempState() {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  assert.equal(stateDir.startsWith(tmpdir()), true);
  assert.equal(stateDir.startsWith(WORKTREE), false);
  return stateDir;
}

/**
 * In-memory authorization server. The PKCE verifier is observed only on the token request.
 * Nothing here is written under the worktree.
 */
function createAuthServer({ resource = MCP } = {}) {
  let expectedChallenge = '';
  const grants = [];
  const calls = [];
  let postedVerifier = '';
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const text = bodyText(init?.body);
    calls.push({ method, pathname: parsed.pathname, authorization: headers.get('authorization'), body: text });
    if (method === 'GET' && parsed.pathname === '/mcp') return new Response('Method Not Allowed', { status: 405 });
    if (parsed.pathname.includes('oauth-protected-resource')) {
      return json({
        resource,
        authorization_servers: [ORIGIN],
        scopes_supported: ['mcp']
      });
    }
    if (parsed.pathname.includes('oauth-authorization-server')) {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (parsed.pathname === '/register' && method === 'POST') {
      const requested = JSON.parse(text);
      return json({ ...requested, client_id: 'dyn-client', token_endpoint_auth_method: 'none' });
    }
    if (parsed.pathname === '/token' && method === 'POST') {
      const params = new URLSearchParams(text);
      const grant = params.get('grant_type');
      grants.push(grant);
      if (grant === 'refresh_token') {
        return json({ error: 'invalid_grant', error_description: 'refresh rejected' }, 400);
      }
      postedVerifier = params.get('code_verifier') ?? '';
      if (!expectedChallenge || s256(postedVerifier) !== expectedChallenge) {
        return json({ error: 'invalid_grant', error_description: 'pkce mismatch' }, 400);
      }
      if (params.get('redirect_uri') !== REDIRECT) {
        return json({ error: 'invalid_grant', error_description: 'redirect mismatch' }, 400);
      }
      return json({
        access_token: ISSUED_ACCESS,
        refresh_token: ISSUED_REFRESH,
        token_type: 'Bearer',
        expires_in: 3600
      });
    }
    if (method === 'POST' && parsed.pathname === '/mcp') {
      const msg = JSON.parse(text);
      const bearer = headers.get('authorization');
      if (bearer !== `Bearer ${ISSUED_ACCESS}`) {
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
          }
        });
      }
      if (msg.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT });
      }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (msg.method === 'tools/list') {
        return json({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
        });
      }
      return new Response('unexpected', { status: 500 });
    }
    return new Response(`unexpected ${method} ${parsed.pathname}`, { status: 500 });
  };
  return {
    fetchImpl,
    calls,
    grants,
    setChallenge(value) {
      expectedChallenge = value;
    },
    postedVerifier() {
      return postedVerifier;
    }
  };
}

function authorizationUrlFrom(error) {
  const line = String(error.message)
    .split('\n')
    .find((item) => item.startsWith(MCP_OAUTH_AUTHORIZATION_PREFIX));
  assert.ok(line, error.message);
  return new URL(line.slice(MCP_OAUTH_AUTHORIZATION_PREFIX.length));
}

function endpoint(extra = {}) {
  return {
    url: MCP,
    oauth: true,
    oauthRedirectUrl: REDIRECT,
    transport: 'streamable-http',
    ...extra
  };
}

test('oauth config is optional and does not keep a client secret from JSON', () => {
  const parsed = parseMcpHttpConfig({
    RAW_AGENT_MCP_HTTP: JSON.stringify([
      {
        url: 'http://a/mcp',
        oauth: { redirectUrl: REDIRECT, scope: 'mcp', clientSecret: 'super-secret-value' }
      },
      { url: 'http://b/mcp', oauth: true, oauthClientId: 'pre-client', bearerEnv: 'TOK' },
      { url: 'http://c/mcp', bearerEnv: 'TOK' }
    ])
  });
  assert.equal(parsed.endpoints[0].oauth, true);
  assert.equal(parsed.endpoints[0].oauthRedirectUrl, REDIRECT);
  assert.equal(parsed.endpoints[0].oauthScope, 'mcp');
  assert.equal(JSON.stringify(parsed.endpoints[0]).includes('super-secret-value'), false);
  assert.equal(parsed.endpoints[1].oauth, true);
  assert.equal(parsed.endpoints[1].oauthClientId, 'pre-client');
  assert.equal(parsed.endpoints[1].bearerEnv, 'TOK');
  assert.equal(parsed.endpoints[2].oauth, undefined);
  assert.equal(parsed.endpoints[2].bearerEnv, 'TOK');
});

test('oauth without a state directory fails before any request', async () => {
  let calls = 0;
  const session = new McpHttpSession(
    0,
    { url: MCP, oauth: true },
    {
      fetch: async () => {
        calls += 1;
        return new Response('no', { status: 500 });
      },
      timeoutMs: 2000
    }
  );
  await assert.rejects(() => session.connect(), /state directory/);
  assert.equal(calls, 0);
  await session.close();
});

test('bearer sessions do not write oauth state or discover an authorization server', async () => {
  const stateDir = tempState();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    if (method === 'GET') return new Response('Method Not Allowed', { status: 405 });
    const msg = JSON.parse(String(init.body));
    if (msg.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT });
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response('unexpected', { status: 500 });
  };
  const session = new McpHttpSession(
    0,
    { url: MCP, bearerEnv: 'ROOM_TOKEN', transport: 'streamable-http' },
    { env: { ROOM_TOKEN: 'bearer-test-token-value' }, fetch: fetchImpl, stateDir, timeoutMs: 2000 }
  );
  try {
    await session.connect();
    assert.equal(existsSync(join(stateDir, 'mcp-oauth')), false);
    assert.equal(
      calls.some((call) => call.url.includes('well-known')),
      false
    );
    assert.equal(session.isConnected, true);
  } finally {
    await session.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('PKCE authorization code flow stores the verifier only in the state dir', async () => {
  const stateDir = tempState();
  const server = createAuthServer();
  const session = new McpHttpSession(0, endpoint(), { fetch: server.fetchImpl, stateDir, timeoutMs: 2000 });
  let verifier = '';
  let verifierPath = '';
  let authUrl;
  let again;
  try {
    await assert.rejects(
      () => session.connect(),
      (error) => {
        authUrl = authorizationUrlFrom(error);
        assert.equal(authUrl.origin + authUrl.pathname, `${ORIGIN}/authorize`);
        assert.equal(authUrl.searchParams.get('response_type'), 'code');
        assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authUrl.searchParams.get('redirect_uri'), REDIRECT);
        assert.ok(authUrl.searchParams.get('code_challenge'));
        assert.ok(authUrl.searchParams.get('state'));
        assert.equal(authUrl.searchParams.get('code_verifier'), null);
        assert.equal(authUrl.searchParams.get('access_token'), null);
        assert.equal(authUrl.searchParams.get('client_secret'), null);
        server.setChallenge(authUrl.searchParams.get('code_challenge'));
        const paths = findNamed(stateDir, 'verifier');
        assert.equal(paths.length, 1);
        verifierPath = paths[0];
        assert.equal(verifierPath.startsWith(stateDir), true);
        assert.equal(verifierPath.startsWith(WORKTREE), false);
        assert.equal(statSync(verifierPath).mode & 0o777, 0o600);
        verifier = readFileSync(verifierPath, 'utf8');
        assert.equal(s256(verifier), authUrl.searchParams.get('code_challenge'));
        assert.equal(error.message.includes(verifier), false);
        assert.equal(error.message.includes(ISSUED_ACCESS), false);
        return true;
      }
    );
    assert.ok(authUrl);
    assert.equal(
      server.calls.some((call) => call.pathname === '/authorize'),
      false
    );
    await assert.rejects(
      () =>
        finishMcpHttpOAuth({
          stateDir,
          code: 'auth-code-value-1',
          state: 'wrong-state-value-should-not-leak',
          fetch: server.fetchImpl
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /invalid oauth state/);
        assert.equal(error.message.includes('wrong-state-value-should-not-leak'), false);
        assert.equal(error.message.includes(verifier), false);
        return true;
      }
    );
    assert.equal(server.grants.includes('authorization_code'), false);
    const done = await finishMcpHttpOAuth({
      stateDir,
      code: 'auth-code-value-1',
      state: authUrl.searchParams.get('state'),
      fetch: server.fetchImpl
    });
    assert.equal(done.endpointUrl, MCP);
    assert.equal(server.postedVerifier(), verifier);
    assert.equal(s256(server.postedVerifier()), authUrl.searchParams.get('code_challenge'));
    assert.equal(existsSync(verifierPath), false);
    assert.equal(JSON.stringify(done).includes(ISSUED_ACCESS), false);
    const tokenFiles = findNamed(stateDir, 'tokens.json');
    assert.equal(tokenFiles.length, 1);
    assert.equal(statSync(tokenFiles[0]).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(tokenFiles[0], 'utf8'));
    assert.equal(stored.access_token, ISSUED_ACCESS);
    assert.equal(stored.refresh_token, ISSUED_REFRESH);

    again = new McpHttpSession(0, endpoint(), { fetch: server.fetchImpl, stateDir, timeoutMs: 2000 });
    await again.connect();
    assert.equal(again.isConnected, true);
    const listed = await again.listTools();
    assert.equal(listed[0].name, 'whoami');
    const authed = server.calls.filter(
      (call) => call.pathname === '/mcp' && call.authorization === `Bearer ${ISSUED_ACCESS}`
    );
    assert.ok(authed.length >= 1);
  } finally {
    await again?.close();
    await session.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a failed refresh returns an authorization URL and drops the refresh token from the error', async () => {
  const stateDir = tempState();
  const access = 'test-access-token';
  const refresh = 'test-refresh-token';
  const spec = endpoint();
  const provider = new McpOAuthClientProvider({ endpoint: spec, stateDir, env: {} });
  await provider.saveClientInformation({
    client_id: 'pre-registered-client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  });
  await provider.saveTokens({ access_token: access, refresh_token: refresh, token_type: 'Bearer' });
  const server = createAuthServer();
  const session = new McpHttpSession(0, spec, { fetch: server.fetchImpl, stateDir, timeoutMs: 2000 });
  try {
    await assert.rejects(
      () => session.connect(),
      (error) => {
        const url = authorizationUrlFrom(error);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(url.searchParams.get('code_challenge'));
        assert.ok(url.searchParams.get('state'));
        assert.equal(error.message.includes(access), false);
        assert.equal(error.message.includes(refresh), false);
        assert.equal(url.searchParams.get('code_verifier'), null);
        const verifier = readFileSync(findNamed(stateDir, 'verifier')[0], 'utf8');
        assert.equal(s256(verifier), url.searchParams.get('code_challenge'));
        assert.equal(error.message.includes(verifier), false);
        return true;
      }
    );
    assert.deepEqual(server.grants, ['refresh_token']);
    assert.equal(
      server.calls.some((call) => call.pathname === '/authorize'),
      false
    );
    const firstPost = server.calls.find((call) => call.method === 'POST' && call.pathname === '/mcp');
    assert.equal(firstPost.authorization, `Bearer ${access}`);
    assert.equal(existsSync(findNamed(stateDir, 'tokens.json')[0] ?? ''), false);
  } finally {
    await session.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
