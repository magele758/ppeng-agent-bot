import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SoftwareExecution } from '../dist/connectors/software-execution.js';
import { isPrivateOrReservedIp } from '../dist/goal/run-verify.js';
import { sanitizeSpawnEnv } from '../dist/sandbox/env-sanitizer.js';

const RESERVED = [
  'grep_files',
  'browser_screenshot',
  'history_search',
  'history_read',
  'memory_read',
  'message_agent',
  'cron_create',
  'cron_list',
  'cron_remove',
  'cron_custom'
];

function memory() {
  const map = new Map();
  return {
    getDaemonControl: (key) => structuredClone(map.get(key)),
    setDaemonControl: (key, value) => map.set(key, structuredClone(value))
  };
}

function httpTool(name) {
  return {
    name,
    description: 'software',
    inputSchema: { type: 'object' },
    executor: { kind: 'http', url: 'https://example.com', method: 'GET' }
  };
}

function egressCases() {
  const literals = [
    '100.64.0.0',
    '100.100.100.200',
    '100.127.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '8.8.8.8',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.2',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1'
  ];
  const cases = literals.map((ip) => {
    const url = ip.includes(':') ? `http://[${ip}]/` : `http://${ip}/`;
    return { id: `lit_${ip.replaceAll(/[:.]/g, '_')}`, url, method: 'GET', deny: isPrivateOrReservedIp(ip) };
  });
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    cases.push({
      id: `ro_${method.toLowerCase()}_metadata`,
      url: 'http://100.100.100.200/latest/meta-data/',
      method,
      deny: true
    });
  }
  cases.push(
    { id: 'mapped_metadata', url: 'http://[::ffff:100.100.100.200]/', method: 'GET', deny: true },
    { id: 'mapped_loopback', url: 'http://[::ffff:127.0.0.1]/', method: 'GET', deny: true },
    { id: 'mapped_public', url: 'http://[::ffff:8.8.8.8]/', method: 'GET', deny: false },
    { id: 'public_v6', url: 'http://[2001:db8::1]/', method: 'GET', deny: false },
    { id: 'unspecified_v6', url: 'http://[::]/', method: 'GET', deny: true },
    { id: 'multicast', url: 'http://224.0.0.1/', method: 'GET', deny: true },
    { id: 'dns_cgnat', url: 'http://cgnat.example/latest/meta-data/', method: 'GET', deny: true },
    { id: 'dns_mixed', url: 'http://mixed.example/latest', method: 'HEAD', deny: true },
    { id: 'dns_public', url: 'http://public.example/', method: 'GET', deny: false }
  );
  return cases;
}

test('read-only software HTTP matches private address policy [AC:software-egress-reserved-tools#AC-1] [AC:software-egress-reserved-tools#AC-2]', () => {
  const cases = egressCases();
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      fileURLToPath(new URL('./helpers/software-egress-policy-fixture.mjs', import.meta.url)),
      JSON.stringify(cases.map(({ id, url, method }) => ({ id, url, method })))
    ],
    { encoding: 'utf8', env: sanitizeSpawnEnv(), timeout: 15000 }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const outcomes = JSON.parse(result.stdout);
  assert.equal(outcomes.length, cases.length);
  for (const item of cases) {
    const outcome = outcomes.find((row) => row.id === item.id);
    assert.ok(outcome, item.id);
    if (item.deny) {
      assert.equal(outcome.attempts, 0, `${item.id} sent a request: ${outcome.content}`);
      assert.match(outcome.content, /Private address denied by network policy/);
      assert.equal(outcome.ok, false);
    } else {
      assert.equal(outcome.attempts, 1, `${item.id} was blocked: ${outcome.content}`);
      assert.doesNotMatch(outcome.content, /Private address denied by network policy/);
    }
  }
});

test('software bindings cannot take builtin tool names or hide them from other sessions [AC:software-egress-reserved-tools#AC-3]', () => {
  const store = memory();
  const execution = new SoftwareExecution(store);
  const principal = execution.principal({ userId: 'owner' });
  for (const name of RESERVED) {
    assert.throws(
      () => execution.bind(principal, 'bot-a', `bind_${name}`, { tools: [httpTool(name)] }),
      /Invalid or duplicate tool name/,
      name
    );
  }
  assert.equal(execution.list(principal, 'bot-a').length, 0);

  execution.bind(principal, 'bot-a', 'custom', { tools: [httpTool('ticket_lookup')] });
  const key = JSON.stringify([principal, 'bot-a', 'legacy']);
  const rows = store.getDaemonControl('software_connections_v1');
  rows[key] = {
    principal,
    botId: 'bot-a',
    connectorId: 'legacy',
    health: 'configured',
    tools: [...RESERVED, 'browser_navigate', 'vision_analyze'].map((name) => httpTool(name))
  };
  store.setDaemonControl('software_connections_v1', rows);

  const builtinNames = [...RESERVED, 'vision_analyze', 'browser_navigate'];
  const catalog = [
    ...builtinNames.map((name) => ({ name, description: 'builtin' })),
    ...execution.tools()
  ];
  const other = execution.filterForSession(catalog, { metadata: { userId: 'other', botId: 'bot-b' } });
  for (const name of builtinNames) {
    assert.ok(other.some((tool) => tool.name === name && tool.description === 'builtin'), `${name} shadowed`);
  }
  assert.equal(other.some((tool) => tool.name === 'ticket_lookup'), false);
  assert.equal(other.some((tool) => tool.name === 'vision_analyze' && tool.description === 'software'), false);

  const owner = execution.filterForSession(catalog, { metadata: { userId: 'owner', botId: 'bot-a' } });
  assert.ok(owner.some((tool) => tool.name === 'ticket_lookup'));
  for (const name of builtinNames) {
    assert.ok(owner.some((tool) => tool.name === name && tool.description === 'builtin'), `${name} missing for owner`);
  }
});
