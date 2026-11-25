import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { loadWorkspaceSkills } from '../dist/skills/skill-registry.js';
import { buildRedactionEnv, redactToolContent } from '../dist/sandbox/result-redaction.js';
import {
  bindSecretVault,
  createMemorySecretVault,
  runWithSecretRefs,
  createPasswordOneClient,
  resolvePasswordOneConfig,
  PasswordOneClientError,
  passwordOneListHandles,
  passwordOneProxyHttp,
  passwordOneProxyExec,
  passwordOneScrubText,
  passwordOneVerifyAudit
} from '../dist/secrets/index.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { McpManager } from '../dist/mcp/mcp-manager.js';
import { executeToolCalls, processToolResults } from '../dist/runtime/tool-loop.js';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));

function makeMinimalToolServices() {
  return {
    loadSkill: async () => ({ content: '' }),
    searchSkills: async () => ({ content: '{"hits":[]}' }),
    updateTodo: async (_sessionId: string, items: unknown[]) => items,
    createTask: async () => {
      throw new Error('unused');
    },
    getTask: async () => undefined,
    listTasks: async () => [],
    updateTask: async () => {
      throw new Error('unused');
    },
    harnessWriteSpec: async () => '',
    spawnSubagent: async () => '',
    spawnTeammate: async () => '',
    listAgents: async () => [],
    sendMail: async () => {
      throw new Error('unused');
    },
    readInbox: async () => [],
    startBackgroundJob: async () => {
      throw new Error('unused');
    },
    getBackgroundJob: async () => undefined,
    listBackgroundJobs: async () => [],
    listWorkspaces: async () => [],
    upsertSessionMemory: async () => {},
    listSessionMemory: async () => [],
    deleteSessionMemory: async () => false,
    visionAnalyze: async () => ''
  };
}

test('SecretVault active secrets (PW1_BROKER_TOKEN + mixed-case API secret) are redacted across raw, %xx, %XX, Base64, and JSON-escaped forms', async (t) => {
  const vault = createMemorySecretVault();
  const brokerToken = 'Pw1Broker+Secret/Token"99??>>';
  const apiSecret = 'sk_' + 'live_Mixed+Case/Api"Secret??>>';
  vault.set('PW1_BROKER_TOKEN', brokerToken);
  vault.set('STRIPE_PROD_API_KEY', apiSecret);
  bindSecretVault(vault);
  t.after(() => bindSecretVault(undefined));

  const env = buildRedactionEnv({});
  assert.equal(env.PW1_BROKER_TOKEN, brokerToken);
  assert.equal(env.STRIPE_PROD_API_KEY, apiSecret);

  for (const [label, secret] of [
    ['PW1_BROKER_TOKEN', brokerToken],
    ['STRIPE_PROD_API_KEY', apiSecret]
  ] as const) {
    const upperPct = encodeURIComponent(secret);
    const lowerPct = upperPct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const jsonEsc = JSON.stringify(secret).slice(1, -1);
    const b64Std = Buffer.from(secret, 'utf8').toString('base64');
    const b64Url = Buffer.from(secret, 'utf8').toString('base64url');
    assert.notEqual(upperPct, lowerPct);
    assert.notEqual(b64Std, b64Url);

    const leaked = `raw=${secret} up=${upperPct} lo=${lowerPct} js=${jsonEsc} b64=${b64Std} b64u=${b64Url}`;
    const scrubbed = redactToolContent(leaked, env);
    for (const form of [secret, upperPct, lowerPct, jsonEsc, b64Std, b64Url]) {
      assert.equal(scrubbed.includes(form), false, `${label} leaked form ${form}`);
    }
    assert.equal(
      scrubbed,
      `raw=[REDACTED:${label}] up=[REDACTED:${label}] lo=[REDACTED:${label}] js=[REDACTED:${label}] b64=[REDACTED:${label}] b64u=[REDACTED:${label}]`
    );
  }

  // Also verify ALS override redaction when not stored in boundVault
  const alsOnly = 'sk_' + 'live_AlsOnly+Tok/5544';
  await runWithSecretRefs({ EPHEMERAL_CRED: alsOnly }, async () => {
    const lower = encodeURIComponent(alsOnly).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const out = redactToolContent(`echo ${alsOnly} ${lower}`, process.env);
    assert.equal(out.includes(alsOnly), false);
    assert.equal(out.includes(lower), false);
    assert.equal(out, 'echo [REDACTED:EPHEMERAL_CRED] [REDACTED:EPHEMERAL_CRED]');
  });
});

test('skill-registry discovers skills/password-one/SKILL.md cleanly with compact progressive disclosure summary and no network:none manifest', async () => {
  const skills = await loadWorkspaceSkills(repoRoot);
  const pw1 = skills.find((s) => s.name === 'password-one');
  assert.ok(pw1, 'skills/password-one/SKILL.md must be discovered by loadWorkspaceSkills');
  assert.equal(pw1.source, 'workspace');
  assert.equal(pw1.skillPath, 'skills/password-one/SKILL.md');
  assert.equal(pw1.manifest, undefined, 'password-one must NOT ship a skill.manifest.json');
  assert.equal(
    existsSync(join(repoRoot, 'skills/password-one/skill.manifest.json')),
    false,
    'skills/password-one/skill.manifest.json must not exist'
  );
  assert.deepEqual(pw1.aliases, ['pw1', 'credential-broker']);
  assert.ok(Array.isArray(pw1.triggerWords) && pw1.triggerWords.includes('pw1'));

  // Description < 180 chars and progressive disclosure index entry < 250 chars
  assert.ok(pw1.description.length < 180, `description too long: ${pw1.description.length}`);
  const summaryLine = `- ${pw1.name}: ${pw1.description}`;
  assert.ok(summaryLine.length < 250, `progressive disclosure summary too long: ${summaryLine.length}`);

  // Key instructions documented (exact CLI delimiter contract matching password-one/src/cli.ts)
  assert.match(pw1.content, /PW1_CLI_PATH/);
  assert.match(pw1.content, /PW1_HANDLE_HINTS/);
  assert.match(pw1.content, /PW1_BROKER_TOKEN/);
  assert.match(pw1.content, /--auth-bearer\s+pw1:\/\//);
  assert.match(pw1.content, /--auth-header\s+"<Header-Name>=pw1:\/\/<alias>"/);
  assert.doesNotMatch(pw1.content, /--auth-header\s+[^\n]*:pw1:\/\//);
  assert.match(pw1.content, /--auth-query\s+"<param>=pw1:\/\/<alias>"/);
  assert.match(pw1.content, /--query\s+"k=v"/);
  assert.match(pw1.content, /--auth-basic\s+"<username>:pw1:\/\/<alias>"/);
  assert.match(pw1.content, /--secret-env/);
  assert.match(pw1.content, /audit-verify/);
  assert.match(pw1.content, /403 POLICY_VIOLATION/);
});

test('default builtin toolset and McpManager add 0 extra tools and 0 bytes extra tool schema', async () => {
  const services = makeMinimalToolServices() as Parameters<typeof createBuiltinTools>[0];
  const savedUrl = process.env.RAW_AGENT_PASSWORD_ONE_URL;
  const savedPw1Url = process.env.PW1_URL;
  const savedToken = process.env.PW1_BROKER_TOKEN;

  try {
    delete process.env.RAW_AGENT_PASSWORD_ONE_URL;
    delete process.env.PW1_URL;
    delete process.env.PW1_BROKER_TOKEN;
    const baselineTools = createBuiltinTools(services);
    const baselineSchema = JSON.stringify(
      baselineTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    );

    process.env.RAW_AGENT_PASSWORD_ONE_URL = 'http://127.0.0.1:52342';
    process.env.PW1_URL = 'http://127.0.0.1:52342';
    process.env.PW1_BROKER_TOKEN = 'test-broker-token-123456';
    const configuredTools = createBuiltinTools(services);
    const configuredSchema = JSON.stringify(
      configuredTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    );

    assert.equal(configuredTools.length, baselineTools.length, 'builtin tool count must remain identical');
    assert.equal(
      Buffer.byteLength(configuredSchema, 'utf8') - Buffer.byteLength(baselineSchema, 'utf8'),
      0,
      'non-secret tool schema delta must be 0 bytes'
    );
    assert.equal(
      configuredTools.some((t) => /pw1|password[-_]?one/i.test(t.name)),
      false,
      'must not register any password-one builtin model tool'
    );
  } finally {
    if (savedUrl === undefined) delete process.env.RAW_AGENT_PASSWORD_ONE_URL;
    else process.env.RAW_AGENT_PASSWORD_ONE_URL = savedUrl;
    if (savedPw1Url === undefined) delete process.env.PW1_URL;
    else process.env.PW1_URL = savedPw1Url;
    if (savedToken === undefined) delete process.env.PW1_BROKER_TOKEN;
    else process.env.PW1_BROKER_TOKEN = savedToken;
  }

  // McpManager must not auto-register anything when only Password One env vars are set
  const mcpTools: unknown[] = [];
  const mgr = new McpManager({
    stateDir: '/tmp/pw1-mcp-zero-delta',
    tools: mcpTools as never,
    env: {
      RAW_AGENT_PASSWORD_ONE_URL: 'http://127.0.0.1:52342',
      PW1_URL: 'http://127.0.0.1:52342',
      PW1_BROKER_TOKEN: 'test-broker-token-123456'
    },
    log: { warn() {}, info() {}, debug() {}, error() {} }
  });
  await mgr.ensureLoaded('s-zero');
  assert.equal(mcpTools.length, 0, 'McpManager must add 0 tools for Password One env');
});

test('password-one-client is opt-in (default-OFF) and rejects CRLF/NUL in tokens and headers without echoing token', async () => {
  assert.equal(resolvePasswordOneConfig({ env: {} }), undefined);
  await assert.rejects(
    () => passwordOneListHandles({ env: {} }),
    (err: unknown) => {
      assert.ok(err instanceof PasswordOneClientError);
      assert.equal(err.code, 'NOT_CONFIGURED');
      return true;
    }
  );

  const crlfToken = 'secret-broker-tok\r\nX-Evil: injected';
  assert.throws(
    () => createPasswordOneClient({ baseUrl: 'http://127.0.0.1:52342', token: crlfToken }),
    (err: unknown) => {
      assert.ok(err instanceof PasswordOneClientError);
      assert.equal(err.code, 'INVALID_INPUT');
      assert.equal(err.message.includes('secret-broker-tok'), false, 'token must never appear in error');
      return true;
    }
  );

  assert.throws(
    () =>
      createPasswordOneClient({
        baseUrl: 'http://127.0.0.1:52342',
        headers: { 'X-Custom': 'ok\nInjected: 1' }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );

  const client = createPasswordOneClient({ baseUrl: 'http://127.0.0.1:52342', token: 'valid-token-123456' });
  await assert.rejects(
    () => client.proxyHttp({ url: 'https://api.example.test', headers: { 'X-Test': 'a\r\nb' } }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
});

test('password-one-client preserves baseUrl path prefix and treats empty/whitespace PW1_BROKER_TOKEN as unset for PW1_AUTH_TOKEN fallback', async (t) => {
  // Empty / whitespace PW1_BROKER_TOKEN falls back to PW1_AUTH_TOKEN
  const fallbackEmpty = resolvePasswordOneConfig({
    env: {
      RAW_AGENT_PASSWORD_ONE_URL: '',
      PW1_URL: 'https://proxy.example.com/pw1/',
      PW1_BROKER_TOKEN: '',
      PW1_AUTH_TOKEN: 'auth-fallback-token-1234'
    }
  });
  assert.ok(fallbackEmpty);
  assert.equal(fallbackEmpty.baseUrl, 'https://proxy.example.com/pw1');
  assert.equal(fallbackEmpty.token, 'auth-fallback-token-1234');

  const fallbackSpaces = resolvePasswordOneConfig({
    env: {
      PW1_URL: 'https://proxy.example.com/pw1',
      PW1_BROKER_TOKEN: '   \t  ',
      PW1_AUTH_TOKEN: 'auth-fallback-token-5678'
    }
  });
  assert.equal(fallbackSpaces?.token, 'auth-fallback-token-5678');

  // Raw CR/LF/NUL in PW1_BROKER_TOKEN must STILL fail closed before trimming/fallback
  assert.throws(
    () =>
      resolvePasswordOneConfig({
        env: {
          PW1_URL: 'https://proxy.example.com/pw1',
          PW1_BROKER_TOKEN: '\r\n',
          PW1_AUTH_TOKEN: 'auth-fallback-token-5678'
        }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );

  // Verify live HTTP request preserves baseUrl path prefix (/pw1 -> /pw1/v1/secrets & /pw1/v1/audit?limit=5)
  const seenRequests: Array<{ method: string; url: string; auth: string }> = [];
  const server = createServer((req, res) => {
    seenRequests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: String(req.headers.authorization ?? '')
    });
    if (req.url === '/pw1/v1/secrets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, secrets: [] }));
      return;
    }
    if (req.url === '/pw1/v1/audit?limit=5') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          verification: { valid: true, entriesChecked: 0, headHash: 'genesis' },
          entries: []
        })
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `unexpected ${req.url}` } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const env = {
    PW1_URL: `http://127.0.0.1:${port}/pw1`,
    PW1_BROKER_TOKEN: '   ',
    PW1_AUTH_TOKEN: 'prefixed-fallback-token-99'
  };

  const handles = await passwordOneListHandles({ env });
  assert.deepEqual(handles, []);
  const audit = await passwordOneVerifyAudit({ env, limit: 5 });
  assert.equal(audit.verification.valid, true);

  assert.deepEqual(seenRequests, [
    { method: 'GET', url: '/pw1/v1/secrets', auth: 'Bearer prefixed-fallback-token-99' },
    { method: 'GET', url: '/pw1/v1/audit?limit=5', auth: 'Bearer prefixed-fallback-token-99' }
  ]);
});

test('password-one-client enforces timeouts, 2 MiB / maxResponseBytes cap, SecretVault token pickup, endpoints, and never leaks PW1_BROKER_TOKEN in errors', async (t) => {
  const brokerToken = 'Pw1Secret+Broker/Token9988';
  let lastAuthHeader = '';

  const server = createServer((req, res) => {
    lastAuthHeader = String(req.headers.authorization ?? '');
    const url = req.url ?? '/';

    if (req.method === 'GET' && url === '/v1/secrets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          secrets: [
            {
              id: 'sec_1',
              alias: 'stripe/prod',
              handle: 'pw1://stripe/prod',
              placeholder: '{{pw1://stripe/prod}}',
              description: 'Stripe API',
              version: 1,
              policy: {
                allowedHosts: ['api.stripe.com'],
                allowedTools: ['http'],
                allowedCommands: [],
                allowHttp: false,
                allowEnvInjection: false,
                crossOriginRedirect: 'block',
                maxLeaseTtlSeconds: 300,
                requireGrant: false
              },
              policyHash: 'abc123',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          ]
        })
      );
      return;
    }

    if (req.method === 'POST' && url === '/v1/proxy/http') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string };
        if (body.url?.includes('slow.test')) {
          // Deliberately stall longer than timeoutMs
          return;
        }
        if (body.url?.includes('huge.test')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { body: 'A'.repeat(4096) } }));
          return;
        }
        if (body.url?.includes('evil.test')) {
          const encodedTok = encodeURIComponent(brokerToken);
          const b64Tok = Buffer.from(brokerToken, 'utf8').toString('base64');
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'POLICY_VIOLATION',
                message: `Disallowed host evil.test; debug leaked ${brokerToken} ${encodedTok} ${b64Tok} Bearer ${brokerToken}`
              }
            })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"balance":100}',
              finalUrl: body.url,
              redirects: [],
              redactionsCount: 0,
              redactedAliases: [],
              durationMs: 3
            }
          })
        );
      });
      return;
    }

    if (req.method === 'POST' && url === '/v1/proxy/exec') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            redactionsCount: 1,
            redactedAliases: ['stripe/prod'],
            durationMs: 5
          }
        })
      );
      return;
    }

    if (req.method === 'POST' && url === '/v1/scrub') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            scrubbedText: '[REDACTED:pw1://stripe/prod]',
            redactionsCount: 1,
            redactedAliases: ['stripe/prod'],
            matches: [{ label: 'pw1://stripe/prod', encoding: 'raw', count: 1 }]
          }
        })
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/v1/audit')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          verification: { valid: true, entriesChecked: 2, headHash: 'deadbeef' },
          entries: []
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'nope' } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Resolve token from SecretVault automatically (not present in env)
  const vault = createMemorySecretVault();
  vault.set('PW1_BROKER_TOKEN', brokerToken);
  bindSecretVault(vault);
  t.after(() => bindSecretVault(undefined));

  const env = { RAW_AGENT_PASSWORD_ONE_URL: baseUrl };

  const handles = await passwordOneListHandles({ env });
  assert.equal(handles.length, 1);
  assert.equal(handles[0]?.handle, 'pw1://stripe/prod');
  assert.equal(lastAuthHeader, `Bearer ${brokerToken}`);

  const httpRes = await passwordOneProxyHttp(
    { url: 'https://api.stripe.com/v1/balance', auth: { type: 'bearer', secret: 'pw1://stripe/prod' } },
    { env }
  );
  assert.equal(httpRes.status, 200);
  assert.equal(httpRes.body, '{"balance":100}');

  const execRes = await passwordOneProxyExec(
    { command: 'node', args: ['-v'], secretEnv: { API_KEY: 'pw1://stripe/prod' } },
    { env }
  );
  assert.equal(execRes.exitCode, 0);
  assert.equal(execRes.redactionsCount, 1);

  const scrubRes = await passwordOneScrubText('leak', { env, source: 'unit-test' });
  assert.equal(scrubRes.scrubbedText, '[REDACTED:pw1://stripe/prod]');

  const auditRes = await passwordOneVerifyAudit({ env, limit: 10 });
  assert.equal(auditRes.verification.valid, true);
  assert.equal(auditRes.verification.entriesChecked, 2);

  // Error path MUST scrub PW1_BROKER_TOKEN (raw, URL-encoded, Base64, Bearer)
  await assert.rejects(
    () => passwordOneProxyHttp({ url: 'https://evil.test/exfil' }, { env }),
    (err: unknown) => {
      assert.ok(err instanceof PasswordOneClientError);
      assert.equal(err.code, 'POLICY_VIOLATION');
      assert.equal(err.statusCode, 403);
      assert.equal(err.message.includes(brokerToken), false, 'raw token leaked in error');
      assert.equal(err.message.includes(encodeURIComponent(brokerToken)), false, 'encoded token leaked');
      assert.equal(
        err.message.includes(Buffer.from(brokerToken, 'utf8').toString('base64')),
        false,
        'base64 token leaked'
      );
      assert.match(err.message, /\[REDACTED:PW1_BROKER_TOKEN\]/);
      return true;
    }
  );

  // Timeout enforcement
  await assert.rejects(
    () => passwordOneProxyHttp({ url: 'https://slow.test/hang' }, { env, timeoutMs: 80 }),
    (err: unknown) => {
      assert.ok(err instanceof PasswordOneClientError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );

  // Max response bytes enforcement
  await assert.rejects(
    () => passwordOneProxyHttp({ url: 'https://huge.test/blob' }, { env, maxResponseBytes: 256 }),
    (err: unknown) => {
      assert.ok(err instanceof PasswordOneClientError);
      assert.equal(err.code, 'RESPONSE_TOO_LARGE');
      return true;
    }
  );
});

test('tool-loop redacts active SecretVault values on tool return path', async (t) => {
  const vault = createMemorySecretVault();
  const brokerToken = 'Pw1Loop+Secret/Tok"42??>>';
  vault.set('PW1_BROKER_TOKEN', brokerToken);
  bindSecretVault(vault);
  t.after(() => bindSecretVault(undefined));

  const appended: unknown[] = [];
  const lowerPct = encodeURIComponent(brokerToken).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const b64 = Buffer.from(brokerToken, 'utf8').toString('base64');

  const echoTool = {
    name: 'echo_probe',
    description: 'test probe',
    inputSchema: { type: 'object' },
    approvalMode: 'never' as const,
    sideEffectLevel: 'none' as const,
    execute: async () => ({
      ok: true,
      content: `raw=${brokerToken} pct=${lowerPct} b64=${b64}`
    })
  };

  const session = {
    id: 'sess-redact',
    agentId: 'general',
    title: 'redact',
    mode: 'chat' as const,
    status: 'idle' as const,
    todo: [],
    summary: '',
    metadata: { secretRefs: ['PW1_BROKER_TOKEN'] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };

  const deps = {
    tools: [echoTool],
    store: {
      appendMessage: (_sid: string, _role: string, parts: unknown[]) => {
        appended.push(...parts);
      },
      listApprovals: () => [],
      createApproval: () => {
        throw new Error('unused');
      },
      deleteApproval: () => {},
      getTask: () => undefined,
      updateTask: () => {}
    },
    envApprovalPolicy: undefined,
    maxParallelToolCalls: 1,
    modelAdapter: {
      name: 'mock',
      runTurn: async () => ({ stopReason: 'end' as const, assistantParts: [] }),
      summarizeMessages: async () => ''
    },
    stateDir: '/tmp/pw1-tool-loop-redact',
    emitTrace: () => {}
  };

  const context = {
    session,
    repoRoot: '/tmp',
    stateDir: '/tmp/pw1-tool-loop-redact',
    agent: { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] }
  };

  const call = { type: 'tool_call' as const, toolCallId: 'tc_1', name: 'echo_probe', input: {} };
  const results = await executeToolCalls(deps, [call], context, false, session.id);
  processToolResults(deps, results, [call], session, undefined, session.id);

  const serialized = JSON.stringify({ results, appended });
  assert.equal(serialized.includes(brokerToken), false, 'raw SecretVault token must not persist');
  assert.equal(serialized.includes(lowerPct), false, 'percent-encoded SecretVault token must not persist');
  assert.equal(serialized.includes(b64), false, 'base64 SecretVault token must not persist');
  assert.match(serialized, /\[REDACTED:PW1_BROKER_TOKEN\]/);
});

test('password-one-client validates URLs, timeouts, maxResponseBytes, headers, auth bindings, exec/scrub/audit args, and ALS token precedence', async () => {
  // URL validation errors (whitespace baseUrl on resolve returns undefined; createPasswordOneClient calls normalizeBaseUrl)
  assert.equal(resolvePasswordOneConfig({ baseUrl: '   ', env: {} }), undefined);
  assert.throws(
    () => createPasswordOneClient({ baseUrl: '   ', env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  for (const badUrl of ['not-a-url', 'ftp://127.0.0.1:52342', 'http://user:pass@127.0.0.1:52342']) {
    assert.throws(
      () => resolvePasswordOneConfig({ baseUrl: badUrl, env: {} }),
      (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
    );
  }

  // Timeout & maxResponseBytes validation
  assert.throws(
    () => resolvePasswordOneConfig({ baseUrl: 'http://127.0.0.1:52342', timeoutMs: 0, env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => resolvePasswordOneConfig({ baseUrl: 'http://127.0.0.1:52342', maxResponseBytes: 1.5, env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );

  // Header map validation (invalid name + non-string value) and unset URL still validates explicit token/headers
  assert.throws(
    () => resolvePasswordOneConfig({ headers: { 'Bad Header': 'ok' }, env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  assert.throws(
    () =>
      resolvePasswordOneConfig({
        baseUrl: 'http://127.0.0.1:52342',
        headers: { 'X-Num': 123 as unknown as string },
        env: {}
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  assert.equal(resolvePasswordOneConfig({ token: 'ok-tok', headers: { 'X-Ok': '1' }, env: {} }), undefined);

  // Explicit empty/whitespace token resolves to undefined; ALS token takes precedence over env
  assert.equal(resolvePasswordOneConfig({ baseUrl: 'http://127.0.0.1:52342', token: '   ', env: {} })?.token, undefined);
  await runWithSecretRefs({ PW1_BROKER_TOKEN: 'als-broker-tok' }, async () => {
    const cfg = resolvePasswordOneConfig({
      baseUrl: 'http://127.0.0.1:52342',
      env: { PW1_BROKER_TOKEN: 'env-broker-tok' }
    });
    assert.equal(cfg?.token, 'als-broker-tok');
  });

  // proxyHttp, proxyExec, scrubText, verifyAudit input validation
  const client = createPasswordOneClient({ baseUrl: 'http://127.0.0.1:52342', token: 'valid-tok', env: {} });
  await assert.rejects(
    () => client.proxyHttp({ url: '   ' }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => client.proxyHttp({ url: 'https://api.example.test', method: 'GET\r\n' }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () =>
      client.proxyHttp({
        url: 'https://api.example.test',
        auth: { type: 'header', headerName: 'Bad Header', secret: 'pw1://a' }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () =>
      client.proxyHttp({
        url: 'https://api.example.test',
        auth: { type: 'header', headerName: 'X-Api-Key', secret: 'pw1://a', prefix: 'Token \n' }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () =>
      client.proxyHttp({
        url: 'https://api.example.test',
        auth: { type: 'basic', username: 'user\r\n', secret: 'pw1://a' }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () =>
      client.proxyHttp({
        url: 'https://api.example.test',
        auth: { type: 'query', paramName: 'key\n', secret: 'pw1://a' }
      }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => client.proxyExec({ command: '   ' }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => client.scrubText(123 as unknown as string),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => client.verifyAudit(0),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_INPUT'
  );
});

test('password-one-client handles custom headers, auth variants, abort, invalid JSON, declared Content-Length overflow, and network errors', async (t) => {
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let mode: 'ok' | 'bad_json' | 'declared_huge' | 'non_array_secrets' | 'stall' = 'ok';

  const server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (mode === 'stall') {
      return;
    }
    if (mode === 'bad_json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{invalid-json');
      return;
    }
    if (mode === 'declared_huge') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '9999999' });
      res.write('{');
      return;
    }
    if (mode === 'non_array_secrets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          status: 200,
          headers: {},
          body: 'ok',
          finalUrl: 'https://api.example.test',
          redirects: [],
          redactionsCount: 0,
          redactedAliases: [],
          durationMs: 1
        }
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Custom headers forwarded while token wins over custom Authorization header; all 3 non-bearer auth types pass validation
  const client = createPasswordOneClient({
    baseUrl,
    token: 'broker-tok-123',
    headers: { 'X-Trace-Id': 'tr_1', Authorization: 'Bearer spoofed' },
    env: {}
  });
  for (const auth of [
    { type: 'header' as const, headerName: 'X-Api-Key', secret: 'pw1://k', prefix: 'Key ' },
    { type: 'basic' as const, username: 'alice', secret: 'pw1://k' },
    { type: 'query' as const, paramName: 'api_key', secret: 'pw1://k' }
  ]) {
    const r = await client.proxyHttp({ url: 'https://api.example.test', method: 'POST', auth });
    assert.equal(r.status, 200);
  }
  assert.equal(seenHeaders[0]?.['x-trace-id'], 'tr_1');
  assert.equal(seenHeaders[0]?.authorization, 'Bearer broker-tok-123');

  // Non-array secrets defaults cleanly to []
  mode = 'non_array_secrets';
  assert.deepEqual(await client.listHandles(), []);

  // Malformed JSON -> INVALID_RESPONSE
  mode = 'bad_json';
  await assert.rejects(
    () => client.listHandles(),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'INVALID_RESPONSE'
  );

  // Declared Content-Length > maxResponseBytes -> RESPONSE_TOO_LARGE
  mode = 'declared_huge';
  await assert.rejects(
    () => passwordOneListHandles({ baseUrl, token: 'broker-tok-123', maxResponseBytes: 512, env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'RESPONSE_TOO_LARGE'
  );

  // In-flight AbortSignal -> ABORTED
  mode = 'stall';
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(
    () => passwordOneListHandles({ baseUrl, token: 'broker-tok-123', signal: ac.signal, env: {} }),
    (err: unknown) => err instanceof PasswordOneClientError && err.code === 'ABORTED'
  );

  // Connection refused -> NETWORK_ERROR without leaking token
  const dead = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  await assert.rejects(
    () => passwordOneListHandles({ baseUrl: `http://127.0.0.1:${deadPort}`, token: 'secret-net-tok', env: {} }),
    (err: unknown) =>
      err instanceof PasswordOneClientError &&
      err.code === 'NETWORK_ERROR' &&
      !err.message.includes('secret-net-tok')
  );
});
