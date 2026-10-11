import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpSession, isLegacySseEndpointError } from '../dist/mcp/mcp-http.js';
import { parseMcpHttpConfig, parseMcpHttpEndpoints } from '../dist/mcp/mcp-http-config.js';

const INIT_RESULT = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: {} },
  serverInfo: { name: 'mock', version: '0' }
};

function jsonRpc(id, result, extraHeaders = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders }
  });
}

function record(calls, url, init) {
  const headers = new Headers(init?.headers ?? {});
  const call = {
    method: String(init?.method ?? 'GET').toUpperCase(),
    url: String(url),
    accept: headers.get('accept'),
    authorization: headers.get('authorization'),
    session: headers.get('mcp-session-id'),
    custom: headers.get('x-custom'),
    bodyText: typeof init?.body === 'string' ? init.body : ''
  };
  calls.push(call);
  return call;
}

function streamableFetch(calls, { sessionId } = {}) {
  return async (url, init) => {
    const call = record(calls, url, init);
    if (call.method === 'GET') return new Response('Method Not Allowed', { status: 405 });
    const msg = JSON.parse(call.bodyText);
    if (msg.method === 'initialize') {
      return jsonRpc(msg.id, INIT_RESULT, sessionId ? { 'mcp-session-id': sessionId } : {});
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') {
      return jsonRpc(msg.id, {
        tools: [
          {
            name: 'whoami',
            description: 'id',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          }
        ]
      });
    }
    if (msg.method === 'tools/call') {
      return jsonRpc(msg.id, { content: [{ type: 'text', text: JSON.stringify({ handle: 'tester' }) }] });
    }
    return new Response('unexpected', { status: 500 });
  };
}

test('parseMcpHttpConfig merges JSON and legacy URLs and aligns bearers on commas', () => {
  const parsed = parseMcpHttpConfig({
    RAW_AGENT_MCP_HTTP: JSON.stringify([
      { url: 'http://a/mcp', bearerEnv: 'TOK', transport: 'streamable-http' },
      { url: 'http://b/mcp', headers: { Authorization: 'Bearer keep' } }
    ]),
    RAW_AGENT_MCP_URLS: 'http://b/mcp,http://c/mcp',
    RAW_AGENT_MCP_BEARER: 'ignored, from-legacy'
  });
  assert.equal(parsed.invalidJson, false);
  assert.deepEqual(
    parsed.endpoints.map((endpoint) => endpoint.url),
    ['http://a/mcp', 'http://b/mcp', 'http://c/mcp']
  );
  assert.equal(parsed.endpoints[0].bearerEnv, 'TOK');
  assert.equal(parsed.endpoints[0].headers, undefined);
  assert.equal(parsed.endpoints[1].headers.Authorization, 'Bearer keep');
  assert.equal(parsed.endpoints[2].headers.Authorization, 'Bearer from-legacy');

  const broken = parseMcpHttpConfig({ RAW_AGENT_MCP_HTTP: '{', RAW_AGENT_MCP_URL: 'http://z/mcp' });
  assert.equal(broken.invalidJson, true);
  assert.equal(parseMcpHttpEndpoints({ RAW_AGENT_MCP_HTTP: '{', RAW_AGENT_MCP_URL: 'http://z/mcp' })[0].url, 'http://z/mcp');
});

test('legacy SSE detection ignores 401 and 406', () => {
  assert.equal(isLegacySseEndpointError({ code: 405, message: 'no' }), true);
  assert.equal(isLegacySseEndpointError(new Error('Method Not Allowed')), true);
  assert.equal(isLegacySseEndpointError(new Error('Unexpected content type: text/event-stream')), true);
  assert.equal(isLegacySseEndpointError({ code: 401, message: 'text/event-stream' }), false);
  assert.equal(isLegacySseEndpointError({ code: 406, message: 'Method Not Allowed' }), false);
  assert.equal(isLegacySseEndpointError(new Error('connect ECONNREFUSED')), false);
});

test('streamable HTTP initialize uses dual Accept, bearer, and session id only after the server returns one', async () => {
  const calls = [];
  const session = new McpHttpSession(
    0,
    {
      url: 'http://127.0.0.1:9/mcp',
      bearerEnv: 'ROOM_TOKEN',
      headers: { 'X-Custom': 'room' }
    },
    {
      env: { ROOM_TOKEN: 'agt_test_token_value' },
      fetch: streamableFetch(calls, { sessionId: 'sess-1' }),
      timeoutMs: 2000
    }
  );
  try {
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const posts = calls.filter((call) => call.method === 'POST');
    assert.ok(posts.length >= 2);
    const init = JSON.parse(posts[0].bodyText);
    assert.equal(init.method, 'initialize');
    assert.equal(init.params.protocolVersion, '2025-11-25');
    assert.equal(init.params.clientInfo.name, 'raw-agent');
    assert.equal(init.params.clientInfo.version, '0.1.0');
    for (const post of posts) {
      assert.equal(post.accept, 'application/json, text/event-stream');
      assert.equal(post.authorization, 'Bearer agt_test_token_value');
      assert.equal(post.custom, 'room');
    }
    assert.equal(posts[0].session, null);
    const notified = posts.find((call) => JSON.parse(call.bodyText).method === 'notifications/initialized');
    assert.ok(notified);
    assert.equal(notified.session, 'sess-1');
    const gets = calls.filter((call) => call.method === 'GET');
    assert.ok(gets.length >= 1);
    assert.equal(session.isConnected, true);
    const tools = await session.listTools();
    assert.equal(tools[0].name, 'whoami');
    assert.equal(tools[0].readOnlyHint, true);
    const who = await session.callTool('whoami', { approval: 'approved' });
    assert.match(who.content, /tester/);
    assert.equal(who.content.includes('«external'), false);
  } finally {
    await session.close();
  }
});

test('stateless streamable HTTP does not send mcp-session-id', async () => {
  const calls = [];
  const session = new McpHttpSession(
    0,
    { url: 'http://127.0.0.1:9/mcp' },
    { fetch: streamableFetch(calls), timeoutMs: 2000 }
  );
  try {
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(calls.filter((call) => call.method === 'POST').length >= 2);
    for (const call of calls) assert.equal(call.session, null);
  } finally {
    await session.close();
  }
});

test('401 and 406 fail without an SSE GET and bearer values are redacted', async () => {
  const token = 'agt_test_token_value';
  for (const status of [401, 406]) {
    let gets = 0;
    const fetchImpl = async (_url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        gets += 1;
        return new Response('no', { status: 500 });
      }
      return new Response(`denied ${token}`, { status });
    };
    const session = new McpHttpSession(
      0,
      { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${token}` } },
      { fetch: fetchImpl, timeoutMs: 2000 }
    );
    await assert.rejects(
      () => session.connect(),
      (error) => {
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.message.includes(token), false);
        return true;
      }
    );
    assert.equal(gets, 0, `status ${status} must not GET`);
    await session.close();
  }
});

test('POST 405 falls back to the legacy SSE transport', { timeout: 8000 }, async () => {
  const calls = [];
  let closeStream = () => {};
  let pushEvent = (_chunk) => {};
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    const call = record(calls, url, init);
    if (call.method === 'GET') {
      let controller;
      const stream = new ReadableStream({
        start(control) {
          controller = control;
          control.enqueue(encoder.encode('event: endpoint\ndata: http://127.0.0.1:9/message\n\n'));
        }
      });
      pushEvent = (chunk) => controller.enqueue(encoder.encode(chunk));
      closeStream = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      init?.signal?.addEventListener?.('abort', closeStream, { once: true });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (call.url.endsWith('/mcp')) return new Response('Method Not Allowed', { status: 405 });
    const msg = JSON.parse(call.bodyText);
    if (msg.method === 'initialize') {
      pushEvent(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT })}\n\n`
      );
      return new Response(null, { status: 202 });
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response('unexpected', { status: 500 });
  };
  const session = new McpHttpSession(
    0,
    { url: 'http://127.0.0.1:9/mcp' },
    { fetch: fetchImpl, timeoutMs: 2000 }
  );
  try {
    await session.connect();
    assert.equal(session.isConnected, true);
    assert.ok(calls.some((call) => call.method === 'POST' && call.url.endsWith('/mcp')));
    assert.ok(calls.some((call) => call.method === 'GET'));
  } finally {
    await session.close();
    closeStream();
  }
});
