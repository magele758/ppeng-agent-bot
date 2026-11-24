import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  CONTEXT_GRAPH_ARTIFACT_HEADING,
  DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS,
  MAX_CONTEXT_GRAPH_TIMEOUT_MS,
  MIN_CONTEXT_GRAPH_TIMEOUT_MS,
  MAX_TOOL_EVENTS_PER_BATCH,
  applyPrunedEventsToMessages,
  attachContextGraphArtifactBlock,
  extractToolTrajectoryEvents,
  ingestAndCompileSessionArtifacts,
  resolveContextGraphConfig,
  sessionContextGraphId,
  stripContextGraphArtifactBlock
} from '../dist/session/context-graph-client.js';
import { autoCompactSession } from '../dist/runtime/compact-host.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createExtensionRegistry } from '../dist/extensions/extension-registry.js';
import {
  bindSecretVault,
  createMemorySecretVault,
  runWithSecretRefs
} from '../dist/secrets/index.js';
import type { SessionMessage, SessionRecord } from '../dist/types.js';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      let parsed: Record<string, unknown> = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      handler(req, res, parsed);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function makeToolMessages(sessionId = 'sess-1'): SessionMessage[] {
  return [
    {
      id: 'm1',
      sessionId,
      role: 'user',
      seq: 1,
      parts: [{ type: 'text', text: 'Update src/app.ts and run tests.' }],
      createdAt: '2026-11-01T00:00:00.000Z'
    },
    {
      id: 'm2',
      sessionId,
      role: 'assistant',
      seq: 2,
      parts: [
        {
          type: 'tool_call',
          toolCallId: 'call_write_1',
          name: 'write_file',
          input: { path: 'src/app.ts', content: 'export const v = 1;\n' + '// old\n'.repeat(120) }
        }
      ],
      createdAt: '2026-11-01T00:00:01.000Z'
    },
    {
      id: 'm3',
      sessionId,
      role: 'tool',
      seq: 3,
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call_write_1',
          name: 'write_file',
          ok: true,
          content: 'Wrote src/app.ts (v1)'
        }
      ],
      createdAt: '2026-11-01T00:00:02.000Z'
    },
    {
      id: 'm4',
      sessionId,
      role: 'assistant',
      seq: 4,
      parts: [
        {
          type: 'tool_call',
          toolCallId: 'call_read_1',
          name: 'read_file',
          input: { path: 'src/app.ts' }
        }
      ],
      createdAt: '2026-11-01T00:00:03.000Z'
    },
    {
      id: 'm5',
      sessionId,
      role: 'tool',
      seq: 5,
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call_read_1',
          name: 'read_file',
          ok: true,
          content: 'export const v = 1;\n' + 'line\n'.repeat(300)
        }
      ],
      createdAt: '2026-11-01T00:00:04.000Z'
    }
  ];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

function withSavedCgEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const keys = [
    'RAW_AGENT_CONTEXT_GRAPH_URL',
    'CONTEXT_GRAPH_URL',
    'RAW_AGENT_CONTEXT_GRAPH_TOKEN',
    'CONTEXT_GRAPH_TOKEN',
    'CG_AUTH_TOKEN',
    'RAW_AGENT_CONTEXT_GRAPH_TIMEOUT_MS',
    'CONTEXT_GRAPH_TIMEOUT_MS'
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('disabled by default when CONTEXT_GRAPH_URL is unset or invalid -> 0 HTTP calls, returns null', async (t) => {
  let requests = 0;
  const mock = await startMockServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ compiled: { promptText: 'x' }, pruned: { events: [] } }));
  });
  t.after(() => mock.close());

  assert.equal(resolveContextGraphConfig({}), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: '   ' }), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: 'ftp://127.0.0.1:52341' }), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: 'file:///etc/passwd' }), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: 'not-a-valid-url' }), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: 'http://user:pass@127.0.0.1:52341' }), null);
  assert.equal(resolveContextGraphConfig({ CONTEXT_GRAPH_URL: `${mock.baseUrl}\r\nX-Evil: 1` }), null);
  assert.equal(
    resolveContextGraphConfig({
      CONTEXT_GRAPH_URL: mock.baseUrl,
      CONTEXT_GRAPH_TOKEN: 'bad\r\ntoken'
    }),
    null
  );

  // Timeout clamping & precedence
  const cfgDefault = resolveContextGraphConfig({ CONTEXT_GRAPH_URL: mock.baseUrl });
  assert.equal(cfgDefault?.timeoutMs, DEFAULT_CONTEXT_GRAPH_TIMEOUT_MS);

  const cfgLow = resolveContextGraphConfig({
    CONTEXT_GRAPH_URL: mock.baseUrl,
    CONTEXT_GRAPH_TIMEOUT_MS: '10'
  });
  assert.equal(cfgLow?.timeoutMs, MIN_CONTEXT_GRAPH_TIMEOUT_MS);

  const cfgHigh = resolveContextGraphConfig({
    RAW_AGENT_CONTEXT_GRAPH_URL: `${mock.baseUrl}/prefix/`,
    RAW_AGENT_CONTEXT_GRAPH_TIMEOUT_MS: '999999',
    CONTEXT_GRAPH_TIMEOUT_MS: '500'
  });
  assert.equal(cfgHigh?.baseUrl, `${mock.baseUrl}/prefix`);
  assert.equal(cfgHigh?.timeoutMs, MAX_CONTEXT_GRAPH_TIMEOUT_MS);

  const outcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-disabled',
    messages: makeToolMessages('sess-disabled'),
    env: {}
  });
  assert.equal(outcome, null);
  assert.equal(requests, 0);
});

test('pure-chat messages (0 tool calls/results) make 0 HTTP calls even when CONTEXT_GRAPH_URL is set', async (t) => {
  let requests = 0;
  const mock = await startMockServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ compiled: { promptText: 'x' }, pruned: { events: [] } }));
  });
  t.after(() => mock.close());

  const pureChat: SessionMessage[] = [
    {
      id: 'c1',
      sessionId: 'sess-chat',
      role: 'user',
      seq: 1,
      parts: [{ type: 'text', text: 'Hi, how are you?' }],
      createdAt: '2026-11-01T00:00:00.000Z'
    },
    {
      id: 'c2',
      sessionId: 'sess-chat',
      role: 'assistant',
      seq: 2,
      parts: [{ type: 'text', text: 'Doing well! How can I help?' }],
      createdAt: '2026-11-01T00:00:01.000Z'
    },
    {
      id: 'c3',
      sessionId: 'sess-chat',
      role: 'assistant',
      seq: 3,
      key: 'compact-summary',
      parts: [
        { type: 'text', text: 'Earlier summary' },
        { type: 'tool_result', toolCallId: 'ignored', name: 'read_file', ok: true, content: 'ignored' }
      ],
      createdAt: '2026-11-01T00:00:02.000Z'
    }
  ];

  assert.deepEqual(extractToolTrajectoryEvents(pureChat), []);
  const outcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-chat',
    messages: pureChat,
    env: { CONTEXT_GRAPH_URL: mock.baseUrl }
  });
  assert.equal(outcome, null);
  assert.equal(requests, 0);
});

test('first compaction auto-creates deterministic graph on 404 (and handles 409), second hits directly in 1 call; resolves token safely without leaking', async (t) => {
  const seen: RecordedRequest[] = [];
  const createdGraphs = new Set<string>();
  const secretToken = 'cg_tok_Super+Secret/Vault9988';

  const mock = await startMockServer((req, res, body) => {
    const url = req.url ?? '/';
    const authorization = String(req.headers.authorization ?? '');
    seen.push({ method: req.method ?? '', url, authorization, body });

    if (req.method === 'POST' && url === '/cg/v1/graphs') {
      const id = String(body.id ?? '');
      if (createdGraphs.has(id)) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'ALREADY_EXISTS' } }));
        return;
      }
      createdGraphs.add(id);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, name: body.name }));
      return;
    }

    const match = /^\/cg\/v1\/graphs\/([^/]+)\/ingest-artifacts$/.exec(url);
    if (req.method === 'POST' && match) {
      const id = decodeURIComponent(match[1]!);
      if (!createdGraphs.has(id)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'graph missing' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          compiled: {
            promptText: '- `src/app.ts` (v1): exports `v = 1`'
          },
          pruned: {
            prunedCount: 2,
            charsSaved: 1850,
            events: [
              {
                callId: 'call_write_1',
                args: { path: 'src/app.ts', content: '[superseded write payload]' },
                output: 'Wrote src/app.ts (v1)'
              },
              {
                callId: 'call_read_1',
                output: '[pruned read src/app.ts v1]'
              }
            ]
          }
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  t.after(() => mock.close());

  const sessionId = 'session-alpha-42';
  const expectedGraphId = sessionContextGraphId(sessionId);
  assert.match(expectedGraphId, /^sess_[0-9a-f]{24}$/);
  assert.equal(sessionContextGraphId(sessionId), expectedGraphId);

  // Resolve token from bound SecretVault (not in env)
  const vault = createMemorySecretVault();
  vault.set('CONTEXT_GRAPH_TOKEN', secretToken);
  bindSecretVault(vault);
  t.after(() => bindSecretVault(undefined));

  const env = { RAW_AGENT_CONTEXT_GRAPH_URL: `${mock.baseUrl}/cg/` };
  const messages = makeToolMessages(sessionId);

  // First compaction: 404 -> POST /v1/graphs -> retry /ingest-artifacts (3 calls)
  const first = await ingestAndCompileSessionArtifacts({ sessionId, messages, env });
  assert.ok(first && first.applied === true);
  assert.equal(first.graphId, expectedGraphId);
  assert.equal(first.prunedCount, 2);
  assert.equal(first.charsSaved, 1850);
  assert.equal(first.artifactBlock, '- `src/app.ts` (v1): exports `v = 1`');
  assert.equal(seen.length, 3);
  assert.equal(seen[0]!.url, `/cg/v1/graphs/${expectedGraphId}/ingest-artifacts`);
  assert.equal(seen[1]!.url, '/cg/v1/graphs');
  assert.deepEqual(seen[1]!.body, { id: expectedGraphId, name: 'ppeng-session' });
  assert.equal(seen[2]!.url, `/cg/v1/graphs/${expectedGraphId}/ingest-artifacts`);
  assert.deepEqual(seen[2]!.body.compileOptions, { format: 'compact_markdown' });
  for (const req of seen) {
    assert.equal(req.authorization, `Bearer ${secretToken}`);
  }

  // Second compaction: hits /ingest-artifacts directly in 1 call; ALS override wins over SecretVault
  const alsToken = 'cg_als_override_token_777';
  const beforeSecond = seen.length;
  const second = await runWithSecretRefs({ RAW_AGENT_CONTEXT_GRAPH_TOKEN: alsToken }, () =>
    ingestAndCompileSessionArtifacts({ sessionId, messages, env, maxOutputChars: 600 })
  );
  assert.ok(second && second.applied === true);
  assert.equal(seen.length - beforeSecond, 1);
  assert.equal(seen[beforeSecond]!.url, `/cg/v1/graphs/${expectedGraphId}/ingest-artifacts`);
  assert.equal(seen[beforeSecond]!.authorization, `Bearer ${alsToken}`);
  assert.deepEqual(seen[beforeSecond]!.body.compileOptions, {
    format: 'compact_markdown',
    maxOutputChars: 600
  });

  // Verify env fallback precedence (empty RAW_AGENT_CONTEXT_GRAPH_TOKEN -> CG_AUTH_TOKEN)
  bindSecretVault(undefined);
  const envCfg = resolveContextGraphConfig({
    CONTEXT_GRAPH_URL: mock.baseUrl,
    RAW_AGENT_CONTEXT_GRAPH_TOKEN: '   ',
    CONTEXT_GRAPH_TOKEN: '',
    CG_AUTH_TOKEN: 'fallback-cg-auth'
  });
  assert.equal(envCfg?.token, 'fallback-cg-auth');

  // Verify 409 ALREADY_EXISTS on POST /v1/graphs still proceeds to retry /ingest-artifacts
  let raceFirstHit = true;
  const raceMock = await startMockServer((req, res) => {
    const url = req.url ?? '/';
    if (url.endsWith('/ingest-artifacts') && raceFirstHit) {
      raceFirstHit = false;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
      return;
    }
    if (url === '/v1/graphs') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'ALREADY_EXISTS' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        compiled: { promptText: '- `race.ts` (v1)' },
        pruned: { events: [] }
      })
    );
  });
  t.after(() => raceMock.close());
  const raceOutcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-race',
    messages,
    env: { CONTEXT_GRAPH_URL: raceMock.baseUrl }
  });
  assert.ok(raceOutcome && raceOutcome.applied === true);
  assert.equal(raceOutcome.artifactBlock, '- `race.ts` (v1)');
});

test('batch safety slices the most recent 2000 events when trajectory exceeds MAX_TOOL_EVENTS_PER_BATCH', async (t) => {
  let receivedCount = 0;
  let firstCallId = '';
  let lastCallId = '';
  const mock = await startMockServer((_req, res, body) => {
    const events = Array.isArray(body.events) ? (body.events as Array<{ callId: string }>) : [];
    receivedCount = events.length;
    firstCallId = events[0]?.callId ?? '';
    lastCallId = events[events.length - 1]?.callId ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ compiled: { promptText: '- ok' }, pruned: { events: [] } }));
  });
  t.after(() => mock.close());

  const total = MAX_TOOL_EVENTS_PER_BATCH + 7;
  const messages: SessionMessage[] = [];
  for (let i = 0; i < total; i += 1) {
    messages.push({
      id: `t_${i}`,
      sessionId: 'sess-batch',
      role: 'tool',
      seq: i + 1,
      parts: [{ type: 'tool_result', toolCallId: `c_${i}`, name: 'bash', ok: true, content: 'ok' }],
      createdAt: '2026-11-01T00:00:00.000Z'
    });
  }

  const outcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-batch',
    messages,
    env: { CONTEXT_GRAPH_URL: mock.baseUrl }
  });
  assert.ok(outcome && outcome.applied === true);
  assert.equal(receivedCount, MAX_TOOL_EVENTS_PER_BATCH);
  assert.equal(firstCallId, 'c_7');
  assert.equal(lastCallId, `c_${total - 1}`);
});

test('applyPrunedEventsToMessages updates tool_call.input & tool_result.content and strips carried CG blocks without mutating input', () => {
  const original: SessionMessage[] = [
    {
      id: 'sum-1',
      sessionId: 's1',
      role: 'assistant',
      key: 'compact-summary',
      seq: 1,
      parts: [
        {
          type: 'text',
          text: `Goal: ship fix.\n\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\n- old.ts (v1)\n\n## Next steps\nRun tests`
        }
      ],
      createdAt: '2026-11-01T00:00:00.000Z'
    },
    ...makeToolMessages('s1')
  ];

  const snapshotBefore = JSON.stringify(original);
  const unchangedUserMsg = original[1];

  const updated = applyPrunedEventsToMessages(original, [
    {
      callId: 'call_write_1',
      args: { path: 'src/app.ts', content: '[superseded write_file]' },
      output: 'Wrote src/app.ts (v1)'
    },
    {
      callId: 'call_read_1',
      output: '[pruned read_file output]'
    }
  ]);

  // Input must remain completely unmutated
  assert.equal(JSON.stringify(original), snapshotBefore);
  assert.notEqual(updated, original);
  // Untouched message keeps exact reference
  assert.equal(updated[1], unchangedUserMsg);

  // Carried compact-summary has old CG block stripped while preserving ## Next steps
  const summaryPart = updated[0]!.parts[0]!;
  assert.equal(summaryPart.type, 'text');
  assert.equal(summaryPart.text.includes(CONTEXT_GRAPH_ARTIFACT_HEADING), false);
  assert.equal(summaryPart.text.includes('- old.ts (v1)'), false);
  assert.match(summaryPart.text, /Goal: ship fix\./);
  assert.match(summaryPart.text, /## Next steps\nRun tests/);

  // Matching tool_call.input updated (superseded write_file payload shrunk)
  const writeCallPart = updated[2]!.parts[0]!;
  assert.equal(writeCallPart.type, 'tool_call');
  assert.deepEqual(writeCallPart.input, { path: 'src/app.ts', content: '[superseded write_file]' });

  // Matching tool_result.content updated
  const readResultPart = updated[5]!.parts[0]!;
  assert.equal(readResultPart.type, 'tool_result');
  assert.equal(readResultPart.content, '[pruned read_file output]');
});

test('stripContextGraphArtifactBlock & attachContextGraphArtifactBlock prevent duplicate headings across rounds and LLM echoes', () => {
  // Single section at EOF
  assert.equal(
    stripContextGraphArtifactBlock(`Goal: build\n\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\n### Files\n- a.ts (v1)\n\n`),
    'Goal: build'
  );

  // Section followed by another ## heading
  assert.equal(
    stripContextGraphArtifactBlock(
      `## Goal\nShip\n\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\n### Sub\n- a.ts\n\n## Next steps\nVerify`
    ),
    '## Goal\nShip\n\n## Next steps\nVerify'
  );

  // Consecutive duplicate CG headings + CRLF
  assert.equal(
    stripContextGraphArtifactBlock(
      `Summary\r\n\r\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\r\n- old1\r\n\r\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\r\n- old2\r\n\r\n## Tail\r\nkeep`
    ),
    'Summary\r\n\r\n## Tail\r\nkeep'
  );

  // Inline prose mention is NOT stripped
  const inlineMention = `Remember not to echo ${CONTEXT_GRAPH_ARTIFACT_HEADING} manually.`;
  assert.equal(stripContextGraphArtifactBlock(inlineMention), inlineMention);

  // Attach deduplicates echoed headings across multiple rounds
  const round1 = attachContextGraphArtifactBlock('Round 1 summary', '- src/a.ts (v1)', 2000);
  assert.equal(countOccurrences(round1, CONTEXT_GRAPH_ARTIFACT_HEADING), 1);

  const llmEcho = `${round1}\n\nExtra note`;
  const round2 = attachContextGraphArtifactBlock(llmEcho, '- src/a.ts (v2)', 2000);
  assert.equal(countOccurrences(round2, CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
  assert.equal(round2.includes('- src/a.ts (v1)'), false);
  assert.equal(round2.includes('- src/a.ts (v2)'), true);

  // Empty artifact block returns cleaned summary only
  const strippedOnly = attachContextGraphArtifactBlock(round2, '   ', 2000);
  assert.equal(countOccurrences(strippedOnly, CONTEXT_GRAPH_ARTIFACT_HEADING), 0);
  assert.equal(strippedOnly, 'Round 1 summary');

  // Tiny maxTotalChars refuses to crowd out prose summary
  const longBlock = '- ' + 'x'.repeat(200);
  const tinyCapResult = attachContextGraphArtifactBlock('Short prose summary', longBlock, 150);
  assert.equal(tinyCapResult, 'Short prose summary');
  assert.equal(countOccurrences(tinyCapResult, CONTEXT_GRAPH_ARTIFACT_HEADING), 0);
});

test('fail-open safety: 500, 401, malformed JSON, invalid shape, oversized response, connection refused, timeout, and abort never throw or leak token', async (t) => {
  const leakedToken = 'cg_secret_DO_NOT_LEAK_445566';
  let mode: '500' | '401' | 'bad_json' | 'bad_shape' | 'oversized' | 'slow' = '500';

  const mock = await startMockServer((_req, res) => {
    if (mode === 'slow') {
      // Intentionally stall beyond 250ms timeout
      return;
    }
    if (mode === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: `Internal failure Bearer ${leakedToken}` } }));
      return;
    }
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: `Invalid token ${leakedToken}` } }));
      return;
    }
    if (mode === 'bad_json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-valid-json');
      return;
    }
    if (mode === 'bad_shape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ compiled: { promptText: 123 }, pruned: 'nope' }));
      return;
    }
    if (mode === 'oversized') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(5 * 1024 * 1024)
      });
      res.end('{}');
      return;
    }
  });
  t.after(() => mock.close());

  const msgs = makeToolMessages('sess-failopen');
  const baseEnv = {
    CONTEXT_GRAPH_URL: mock.baseUrl,
    CONTEXT_GRAPH_TOKEN: leakedToken,
    CONTEXT_GRAPH_TIMEOUT_MS: '250'
  };

  for (const [nextMode, expectedReason] of [
    ['500', 'http_500'],
    ['401', 'http_401'],
    ['bad_json', 'invalid_json'],
    ['bad_shape', 'invalid_response'],
    ['oversized', 'response_too_large']
  ] as const) {
    mode = nextMode;
    const outcome = await ingestAndCompileSessionArtifacts({
      sessionId: 'sess-failopen',
      messages: msgs,
      env: baseEnv
    });
    assert.ok(outcome && outcome.applied === false, `expected fail-open for ${nextMode}`);
    assert.equal(outcome.fallbackReason, expectedReason);
    assert.equal(JSON.stringify(outcome).includes(leakedToken), false, 'token must never leak');
  }

  // Timeout (250ms)
  mode = 'slow';
  const t0 = Date.now();
  const timeoutOutcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-failopen',
    messages: msgs,
    env: baseEnv
  });
  const elapsed = Date.now() - t0;
  assert.ok(timeoutOutcome && timeoutOutcome.applied === false);
  assert.equal(timeoutOutcome.fallbackReason, 'timeout');
  assert.ok(elapsed >= 200 && elapsed < 2000, `expected timeout near 250ms, got ${elapsed}ms`);

  // Pre-aborted AbortSignal
  const ac = new AbortController();
  ac.abort();
  const abortOutcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-failopen',
    messages: msgs,
    env: baseEnv,
    signal: ac.signal
  });
  assert.ok(abortOutcome && abortOutcome.applied === false);
  assert.equal(abortOutcome.fallbackReason, 'aborted');

  // Connection refused (closed ephemeral port)
  const dead = await startMockServer((_req, res) => res.end('{}'));
  const deadUrl = dead.baseUrl;
  await dead.close();
  const connRefusedOutcome = await ingestAndCompileSessionArtifacts({
    sessionId: 'sess-failopen',
    messages: msgs,
    env: { CONTEXT_GRAPH_URL: deadUrl, CONTEXT_GRAPH_TOKEN: leakedToken, CONTEXT_GRAPH_TIMEOUT_MS: '1000' }
  });
  assert.ok(connRefusedOutcome && connRefusedOutcome.applied === false);
  assert.match(connRefusedOutcome.fallbackReason, /^network_/);
  assert.equal(JSON.stringify(connRefusedOutcome).includes(leakedToken), false);
});

function makeCompactHost(
  store: SqliteStateStore,
  stateDir: string,
  adapter: Record<string, unknown>,
  traces: Array<{ sessionId: string; kind: string; payload?: Record<string, unknown> }>
) {
  return {
    store,
    stateDir,
    modelAdapter: adapter as never,
    extensionRegistry: createExtensionRegistry(),
    turnShapeBySession: new Map(),
    emitTrace(sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) {
      traces.push({ sessionId, kind: event.kind, payload: event.payload });
    },
    prepareMessagesForModel: async (_session: SessionRecord, messages: SessionMessage[]) => messages
  };
}

function makeRunContext(stateDir: string, session: SessionRecord) {
  return {
    repoRoot: stateDir,
    stateDir,
    session,
    agent: {
      id: session.agentId,
      name: session.agentId,
      role: 'assistant',
      instructions: '',
      capabilities: []
    }
  };
}

test('end-to-end autoCompactSession: ordinary session multi-round compaction + fail-open fallback + pure-chat 0-call bypass', async (t) => {
  const createdGraphs = new Set<string>();
  const ingestCalls: Array<{ graphId: string; events: Array<Record<string, unknown>> }> = [];
  let round = 1;
  let forceServerError = false;
  const cgToken = 'cg_e2e_ordinary_secret_9911';

  const mock = await startMockServer((req, res, body) => {
    const url = req.url ?? '/';
    if (forceServerError) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { message: `boom ${cgToken}` } }));
      return;
    }
    if (req.method === 'POST' && url === '/v1/graphs') {
      createdGraphs.add(String(body.id));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: body.id }));
      return;
    }
    const m = /^\/v1\/graphs\/([^/]+)\/ingest-artifacts$/.exec(url);
    if (req.method === 'POST' && m) {
      const graphId = decodeURIComponent(m[1]!);
      if (!createdGraphs.has(graphId)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
        return;
      }
      const events = (body.events ?? []) as Array<Record<string, unknown>>;
      ingestCalls.push({ graphId, events });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          compiled: {
            promptText: `- \`src/core.ts\` (v${round}): active version round ${round}`
          },
          pruned: {
            prunedCount: events.length,
            charsSaved: 2100,
            events: events.map((ev) => ({
              callId: ev.callId,
              args: ev.tool === 'write_file' ? { path: 'src/core.ts', content: '[cg-pruned-write]' } : undefined,
              output: `[cg-pruned-output:${ev.callId}]`
            }))
          }
        })
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  t.after(() => mock.close());

  const stateDir = mkdtempSync(join(tmpdir(), 'cg-ordinary-'));
  const store = new SqliteStateStore(':memory:');
  t.after(() => {
    store.db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const summaryInputs: SessionMessage[][] = [];
  const adapter = {
    name: 'scripted',
    contextWindow: 16_000,
    async runTurn() {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    },
    async summarizeMessages(input: { messages: SessionMessage[] }) {
      summaryInputs.push(input.messages);
      if (round === 2) {
        // Deliberately simulate an LLM accidentally echoing an old CG heading
        return `Round 2 prose summary.\n\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\n- STALE_LLM_ECHO`;
      }
      return `Round ${round} prose summary.`;
    }
  };

  const traces: Array<{ sessionId: string; kind: string; payload?: Record<string, unknown> }> = [];
  const host = makeCompactHost(store, stateDir, adapter, traces);

  await withSavedCgEnv(
    { CONTEXT_GRAPH_URL: mock.baseUrl, CONTEXT_GRAPH_TOKEN: cgToken },
    async () => {
      // 1) Pure-chat ordinary session -> 0 CG requests, 0 cg_compaction traces
      const chatSession = store.createSession({ title: 'pure-chat', mode: 'chat', agentId: 'general' });
      for (let i = 0; i < 28; i += 1) {
        store.appendMessage(chatSession.id, i % 2 === 0 ? 'user' : 'assistant', [
          { type: 'text', text: `chat-turn-${i}` }
        ]);
      }
      const chatRes = await autoCompactSession(host, makeRunContext(stateDir, chatSession), { force: true });
      assert.ok(chatRes.replaced);
      assert.equal(ingestCalls.length, 0);
      assert.equal(traces.filter((e) => e.kind === 'cg_compaction').length, 0);

      // 2) Ordinary tool session — Round 1
      const session = store.createSession({ title: 'tool-session', mode: 'chat', agentId: 'general' });
      const rawWritePayload = 'RAW_WRITE_V1_BODY_' + 'W'.repeat(1600);
      const rawReadOutput = 'RAW_READ_V1_BODY_' + 'R'.repeat(1800);
      store.appendMessage(session.id, 'user', [{ type: 'text', text: 'Edit src/core.ts' }]);
      store.appendMessage(session.id, 'assistant', [
        { type: 'tool_call', toolCallId: 'ord_w1', name: 'write_file', input: { path: 'src/core.ts', content: rawWritePayload } }
      ]);
      store.appendMessage(session.id, 'tool', [
        { type: 'tool_result', toolCallId: 'ord_w1', name: 'write_file', ok: true, content: 'ok w1' }
      ]);
      store.appendMessage(session.id, 'assistant', [
        { type: 'tool_call', toolCallId: 'ord_r1', name: 'read_file', input: { path: 'src/core.ts' } }
      ]);
      store.appendMessage(session.id, 'tool', [
        { type: 'tool_result', toolCallId: 'ord_r1', name: 'read_file', ok: true, content: rawReadOutput }
      ]);
      for (let i = 0; i < 26; i += 1) {
        store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [
          { type: 'text', text: `follow-r1-${i}` }
        ]);
      }

      const r1 = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(session.id)!), { force: true });
      assert.ok(r1.replaced);
      assert.equal(ingestCalls.length, 1);
      // CG server received FULL raw unpruned tool args & output
      assert.equal(ingestCalls[0]!.events.length, 2);
      assert.equal((ingestCalls[0]!.events[0]!.args as { content?: string }).content, rawWritePayload);
      assert.equal(ingestCalls[0]!.events[1]!.output, rawReadOutput);

      // Summarizer received PRUNED tool call input and PRUNED tool result output
      const r1SummarySerialized = JSON.stringify(summaryInputs[summaryInputs.length - 1]);
      assert.equal(r1SummarySerialized.includes(rawWritePayload), false);
      assert.equal(r1SummarySerialized.includes(rawReadOutput), false);
      assert.equal(r1SummarySerialized.includes('[cg-pruned-write]'), true);
      assert.equal(r1SummarySerialized.includes('[cg-pruned-output:ord_r1]'), true);

      const s1After = store.getSession(session.id)!;
      assert.equal(countOccurrences(s1After.summary ?? '', CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
      assert.match(s1After.summary ?? '', /active version round 1/);

      // Trace emitted without secrets
      const cgTracesR1 = traces.filter((e) => e.kind === 'cg_compaction');
      assert.equal(cgTracesR1.length, 1);
      assert.equal(cgTracesR1[0]!.payload?.applied, true);
      assert.equal(cgTracesR1[0]!.payload?.prunedCount, 2);
      assert.equal(cgTracesR1[0]!.payload?.charsSaved, 2100);
      assert.equal(JSON.stringify(cgTracesR1).includes(cgToken), false);

      // 3) Ordinary tool session — Round 2 (direct 1-call ingest + old CG block stripped + LLM echo deduplicated)
      round = 2;
      store.appendMessage(session.id, 'assistant', [
        { type: 'tool_call', toolCallId: 'ord_w2', name: 'write_file', input: { path: 'src/core.ts', content: 'V2' } }
      ]);
      store.appendMessage(session.id, 'tool', [
        { type: 'tool_result', toolCallId: 'ord_w2', name: 'write_file', ok: true, content: 'ok w2' }
      ]);
      for (let i = 0; i < 26; i += 1) {
        store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [
          { type: 'text', text: `follow-r2-${i}` }
        ]);
      }

      const r2 = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(session.id)!), { force: true });
      assert.ok(r2.replaced);
      assert.equal(ingestCalls.length, 2);

      // Summarizer on Round 2 did NOT receive Round 1's CG artifact block in compact-prior-summary / compact-summary
      const r2SummaryInput = JSON.stringify(summaryInputs[summaryInputs.length - 1]);
      assert.equal(r2SummaryInput.includes(CONTEXT_GRAPH_ARTIFACT_HEADING), false);
      assert.equal(r2SummaryInput.includes('active version round 1'), false);

      // Persisted summary & replacement contain EXACTLY ONE CG block (Round 2, no stale LLM echo)
      const s2After = store.getSession(session.id)!;
      assert.equal(countOccurrences(s2After.summary ?? '', CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
      assert.match(s2After.summary ?? '', /active version round 2/);
      assert.equal((s2After.summary ?? '').includes('STALE_LLM_ECHO'), false);

      // 4) Fail-open during ordinary compaction when CG server returns 500
      round = 3;
      forceServerError = true;
      store.appendMessage(session.id, 'assistant', [
        { type: 'tool_call', toolCallId: 'ord_w3', name: 'bash', input: { command: 'npm test' } }
      ]);
      store.appendMessage(session.id, 'tool', [
        { type: 'tool_result', toolCallId: 'ord_w3', name: 'bash', ok: true, content: 'PASS all' }
      ]);
      for (let i = 0; i < 26; i += 1) {
        store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [
          { type: 'text', text: `follow-r3-${i}` }
        ]);
      }

      const r3 = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(session.id)!), { force: true });
      assert.ok(r3.replaced, 'compaction must still succeed when Context Graph returns 500');
      const lastCgTrace = traces.filter((e) => e.kind === 'cg_compaction').at(-1);
      assert.equal(lastCgTrace?.payload?.applied, false);
      assert.equal(lastCgTrace?.payload?.fallbackReason, 'http_500');
      assert.equal(JSON.stringify(lastCgTrace).includes(cgToken), false);
    }
  );
});

test('end-to-end autoCompactSession: canonical bot multi-round compaction receives raw unpruned tool outputs BEFORE pruneLargeToolOutputs and passes optimistic lock cleanly', async (t) => {
  const createdGraphs = new Set<string>();
  const ingestCalls: Array<{ graphId: string; events: Array<Record<string, unknown>> }> = [];
  let round = 1;

  const mock = await startMockServer((req, res, body) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/v1/graphs') {
      createdGraphs.add(String(body.id));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: body.id }));
      return;
    }
    const m = /^\/v1\/graphs\/([^/]+)\/ingest-artifacts$/.exec(url);
    if (req.method === 'POST' && m) {
      const graphId = decodeURIComponent(m[1]!);
      if (!createdGraphs.has(graphId)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
        return;
      }
      const events = (body.events ?? []) as Array<Record<string, unknown>>;
      ingestCalls.push({ graphId, events });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          compiled: {
            promptText: `- \`src/bot.ts\` (v${round}): bot artifact state round ${round}`
          },
          pruned: {
            prunedCount: events.length,
            charsSaved: 3200,
            events: events.map((ev) => ({
              callId: ev.callId,
              args: ev.tool === 'write_file' ? { path: 'src/bot.ts', content: '[bot-cg-pruned-write]' } : undefined,
              output: `[bot-cg-pruned-output:${ev.callId}]`
            }))
          }
        })
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  t.after(() => mock.close());

  const stateDir = mkdtempSync(join(tmpdir(), 'cg-bot-'));
  const store = new SqliteStateStore(':memory:');
  t.after(() => {
    store.db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const completeTextCalls: Array<{ system: string; user: string }> = [];
  const adapter = {
    name: 'scripted-bot',
    contextWindow: 16_000,
    async runTurn() {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    },
    async summarizeMessages() {
      return 'unused';
    },
    async completeText(input: { system: string; user: string }) {
      completeTextCalls.push({ system: input.system, user: input.user });
      if (round === 2) {
        return `- Goal\nKeep going round 2\n\n${CONTEXT_GRAPH_ARTIFACT_HEADING}\n- ECHOED_BOT_ARTIFACT`;
      }
      return `- Goal\nKeep going round ${round}\n- Progress\nEdited src/bot.ts`;
    }
  };

  const traces: Array<{ sessionId: string; kind: string; payload?: Record<string, unknown> }> = [];
  const host = makeCompactHost(store, stateDir, adapter, traces);

  await withSavedCgEnv({ CONTEXT_GRAPH_URL: mock.baseUrl }, async () => {
    const session = store.createSession({
      title: 'canonical-bot',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { canonicalBotChat: true, botId: 'bot-a' }
    });

    // Huge > 500c tool output that pruneLargeToolOutputs WOULD chop to 400c if CG ran after it
    const rawHugeOutput = 'HEADER_LINE\n' + 'EXPORT_FN_BODY_'.repeat(160) + '\nTAIL_SENTINEL_2400C';
    assert.ok(rawHugeOutput.length > 2000);
    const rawHugeWrite = 'BOT_WRITE_SOURCE_' + 'Z'.repeat(1800);

    store.appendMessage(session.id, 'user', [{ type: 'text', text: 'Refactor src/bot.ts' }]);
    store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'bot_w1', name: 'write_file', input: { path: 'src/bot.ts', content: rawHugeWrite } }
    ]);
    store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'bot_w1', name: 'write_file', ok: true, content: rawHugeOutput }
    ]);
    for (let i = 0; i < 26; i += 1) {
      store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [
        { type: 'text', text: `bot-r1-turn-${i}` }
      ]);
    }

    // Round 1 canonical bot compaction
    const r1 = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(session.id)!), { force: true });
    assert.ok(r1.replaced, 'round 1 canonical bot compaction must publish');

    // CG server received the FULL RAW unpruned output (including TAIL_SENTINEL_2400C, NOT 400c preview!)
    assert.equal(ingestCalls.length, 1);
    assert.equal(ingestCalls[0]!.events.length, 1);
    assert.equal(ingestCalls[0]!.events[0]!.output, rawHugeOutput);
    assert.equal((ingestCalls[0]!.events[0]!.args as { content?: string }).content, rawHugeWrite);

    // completeText received the CG-pruned event (both args & output)
    assert.equal(completeTextCalls.length, 1);
    const r1UserJson = JSON.parse(completeTextCalls[0]!.user) as {
      previousSummary: string;
      history: SessionMessage[];
    };
    assert.equal(r1UserJson.previousSummary, '');
    assert.equal(JSON.stringify(r1UserJson.history).includes('[bot-cg-pruned-write]'), true);
    assert.equal(JSON.stringify(r1UserJson.history).includes('[bot-cg-pruned-output:bot_w1]'), true);
    assert.equal(JSON.stringify(r1UserJson.history).includes('TAIL_SENTINEL_2400C'), false);

    // Persisted session.summary AND folded compact-summary replacement both have exactly 1 CG block
    const s1 = store.getSession(session.id)!;
    assert.equal(countOccurrences(s1.summary ?? '', CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
    assert.match(s1.summary ?? '', /bot artifact state round 1/);

    const r1FoldedSummary = store
      .foldMessages(session.id)
      .find((m) => m.key === 'compact-summary');
    assert.ok(r1FoldedSummary);
    const r1FoldedText = r1FoldedSummary.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    assert.equal(countOccurrences(r1FoldedText, CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
    assert.match(r1FoldedText, /bot artifact state round 1/);

    // Round 2 canonical bot compaction:
    // Verifies optimistic concurrency (`(current.summary?.trim() ?? '') === prior`) passes even though
    // `priorForSummary` stripped Round 1's CG block before sending to completeText!
    round = 2;
    const rawR2Output = 'ROUND2_TEST_LOG_' + 'L'.repeat(1200) + '_END_R2';
    store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'bot_b2', name: 'bash', input: { command: 'pnpm test' } }
    ]);
    store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'bot_b2', name: 'bash', ok: true, content: rawR2Output }
    ]);
    for (let i = 0; i < 26; i += 1) {
      store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [
        { type: 'text', text: `bot-r2-turn-${i}` }
      ]);
    }

    const r2 = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(session.id)!), { force: true });
    assert.ok(r2.replaced, 'round 2 canonical bot compaction must pass optimistic lock check');
    assert.equal(
      traces.some((e) => e.kind === 'compact_skipped' && e.payload?.reason === 'stale_summary'),
      false,
      'must not trigger stale_summary'
    );

    // Round 2 previousSummary passed to completeText had Round 1's CG block stripped!
    assert.equal(completeTextCalls.length, 2);
    const r2UserJson = JSON.parse(completeTextCalls[1]!.user) as {
      previousSummary: string;
      history: SessionMessage[];
    };
    assert.equal(r2UserJson.previousSummary.includes(CONTEXT_GRAPH_ARTIFACT_HEADING), false);
    assert.equal(r2UserJson.previousSummary.includes('bot artifact state round 1'), false);
    assert.match(r2UserJson.previousSummary, /Keep going round 1/);

    // Round 2 CG server received full unpruned rawR2Output
    assert.equal(ingestCalls.length, 2);
    assert.equal(ingestCalls[1]!.events[0]!.output, rawR2Output);

    // Persisted session.summary & compact-summary message have EXACTLY ONE CG block (Round 2 only!)
    const s2 = store.getSession(session.id)!;
    assert.equal(countOccurrences(s2.summary ?? '', CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
    assert.match(s2.summary ?? '', /bot artifact state round 2/);
    assert.equal((s2.summary ?? '').includes('ECHOED_BOT_ARTIFACT'), false);
    assert.equal((s2.summary ?? '').includes('bot artifact state round 1'), false);

    const r2FoldedSummary = store
      .foldMessages(session.id)
      .find((m) => m.key === 'compact-summary');
    assert.ok(r2FoldedSummary);
    const r2FoldedText = r2FoldedSummary.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    assert.equal(countOccurrences(r2FoldedText, CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
    assert.match(r2FoldedText, /bot artifact state round 2/);
    assert.equal(r2FoldedText.includes('ECHOED_BOT_ARTIFACT'), false);

    // Pure-chat canonical bot session -> 0 additional CG calls
    const pureBot = store.createSession({
      title: 'canonical-pure-chat',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { canonicalBotChat: true, botId: 'bot-a' }
    });
    for (let i = 0; i < 28; i += 1) {
      store.appendMessage(pureBot.id, i % 2 === 0 ? 'user' : 'assistant', [
        { type: 'text', text: `pure-bot-${i}` }
      ]);
    }
    const callsBeforePureBot = ingestCalls.length;
    const pureBotRes = await autoCompactSession(host, makeRunContext(stateDir, store.getSession(pureBot.id)!), {
      force: true
    });
    assert.ok(pureBotRes.replaced);
    assert.equal(ingestCalls.length, callsBeforePureBot);

    // Canonical bot fallback path (adapter without completeText -> uses summarizeMessages)
    const fallbackSummarizeCalls: SessionMessage[][] = [];
    const fallbackHost = makeCompactHost(
      store,
      stateDir,
      {
        name: 'scripted-bot-no-completeText',
        contextWindow: 16_000,
        async runTurn() {
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
        },
        async summarizeMessages(input: { messages: SessionMessage[] }) {
          fallbackSummarizeCalls.push(input.messages);
          return '- Goal\nFallback summarizeMessages bot round';
        }
      },
      traces
    );
    const fbSession = store.createSession({
      title: 'canonical-bot-fallback',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { canonicalBotChat: true, botId: 'bot-a' }
    });
    store.appendMessage(fbSession.id, 'user', [{ type: 'text', text: 'Run checks' }]);
    store.appendMessage(fbSession.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'fb_1', name: 'bash', input: { command: 'pnpm test' } }
    ]);
    store.appendMessage(fbSession.id, 'tool', [
      { type: 'tool_result', toolCallId: 'fb_1', name: 'bash', ok: true, content: 'RAW_FB_' + 'X'.repeat(800) }
    ]);
    for (let i = 0; i < 26; i += 1) {
      store.appendMessage(fbSession.id, i % 2 === 0 ? 'user' : 'assistant', [
        { type: 'text', text: `fb-turn-${i}` }
      ]);
    }
    const fbRes = await autoCompactSession(
      fallbackHost,
      makeRunContext(stateDir, store.getSession(fbSession.id)!),
      { force: true }
    );
    assert.ok(fbRes.replaced);
    assert.equal(fallbackSummarizeCalls.length, 1);
    assert.equal(JSON.stringify(fallbackSummarizeCalls[0]).includes('[bot-cg-pruned-output:fb_1]'), true);
    const fbAfter = store.getSession(fbSession.id)!;
    assert.equal(countOccurrences(fbAfter.summary ?? '', CONTEXT_GRAPH_ARTIFACT_HEADING), 1);
  });
});
