#!/usr/bin/env node
/**
 * Harness Eval Runner
 * 用法:
 *   node scripts/agent-eval/runner.mjs [--mode fast|nightly] [--suite discovery] [--case <id>] [--grep <substr>] [--exit-on-fail]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { envForEphemeralDaemon, daemonAuthHeaders } from '../spawn-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const FIXTURES_DIR = join(__dirname, 'fixtures');
const TAILSCALE_FIXTURE = join(FIXTURES_DIR, 'tailscale', 'status.json');

// ── 参数解析 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let mode = 'fast';
let suite = null;
let filterCase = null;
let grepFilter = null;
let exitOnFail = false;
let externalBaseUrl = null;
let outputDir = join(repoRoot, 'doc', 'eval-results');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mode' && args[i + 1]) { mode = args[++i]; }
  else if (args[i] === '--suite' && args[i + 1]) { suite = args[++i]; }
  else if (args[i] === '--case' && args[i + 1]) { filterCase = args[++i]; }
  else if (args[i] === '--grep' && args[i + 1]) { grepFilter = args[++i]; }
  else if (args[i] === '--exit-on-fail') { exitOnFail = true; }
  else if (args[i] === '--base-url' && args[i + 1]) { externalBaseUrl = args[++i].replace(/\/$/, ''); }
  else if (args[i] === '--out' && args[i + 1]) { outputDir = args[++i]; }
  else { throw new Error(`unknown or incomplete argument: ${args[i]}`); }
}

if (externalBaseUrl) {
  const parsed = new URL(externalBaseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('--base-url must be an HTTP(S) origin without credentials');
  }
}

function request(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error', headers: externalBaseUrl ? daemonAuthHeaders(options.headers) : options.headers });
}

// ── Daemon 启动 ────────────────────────────────────────────────────────────
const daemonEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'server.js');
if (!externalBaseUrl && !existsSync(daemonEntry)) {
  console.error(`[eval] daemon dist missing — run \`pnpm run build\` first: ${daemonEntry}`);
  process.exit(2);
}

function spawnDaemon({ port, stateDir, extraEnv = {} }) {
  const child = spawn(process.execPath, ['apps/daemon/dist/server.js'], {
    cwd: repoRoot,
    env: {
      ...envForEphemeralDaemon(),
      RAW_AGENT_DAEMON_HOST: '127.0.0.1',
      RAW_AGENT_DAEMON_PORT: String(port),
      RAW_AGENT_STATE_DIR: stateDir,
      RAW_AGENT_E2E_ISOLATE: '1',
      RAW_AGENT_SELF_HEAL_AUTO_START: '0',
      RAW_AGENT_MODEL_PROVIDER: 'heuristic',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (c) => { stderr += c.toString(); });
  return { child, getStderr: () => stderr };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await request(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body && (body.ok === true || body.status)) return body;
      }
    } catch (e) { lastErr = e; }
    await sleep(200);
  }
  throw new Error(`Health check timeout after ${timeoutMs}ms: ${lastErr?.message ?? 'unknown'}`);
}

async function killDaemon(child) {
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ── Discovery helpers ───────────────────────────────────────────────────────
function caseNeedsDiscovery(kase) {
  return Boolean(
    kase.requiresDiscovery
    || kase.capability === 'discovery'
    || String(kase.id ?? '').startsWith('discovery-')
  );
}

function discoveryDaemonEnv() {
  return {
    RAW_AGENT_DISCOVERY: '1',
    RAW_AGENT_TAILSCALE_DISCOVERY: '1',
    RAW_AGENT_TAILSCALE_STATUS_JSON: TAILSCALE_FIXTURE
  };
}

/** Prefer core adapter parse when built; fallback mirrors adapter fields. */
async function parseTailscaleFixture(fixtureRel) {
  const path = join(FIXTURES_DIR, fixtureRel);
  if (!existsSync(path)) throw new Error(`fixture missing: ${path}`);
  const adapterDist = join(repoRoot, 'packages', 'core', 'dist', 'discovery', 'adapters', 'tailscale.js');
  if (existsSync(adapterDist)) {
    const mod = await import(pathToFileURL(adapterDist).href);
    const status = mod.loadTailscaleStatusFromFile(path);
    return mod.parseTailscaleStatusJson(status);
  }
  const status = JSON.parse(readFileSync(path, 'utf8'));
  const suffix = (status.MagicDNSSuffix || 'unknown').replace(/\.$/, '');
  const poolIp = status.Self?.TailscaleIPs?.[0];
  const pool = poolIp ? `tailnet:${poolIp}` : `tailnet:${suffix}`;
  const peers = [];
  if (status.Self) peers.push({ peer: status.Self, isSelf: true });
  for (const peer of Object.values(status.Peer ?? {})) peers.push({ peer, isSelf: false });
  return peers.map(({ peer, isSelf }) => {
    const host = peer.HostName || peer.DNSName || peer.ID || 'unknown';
    const ips = peer.TailscaleIPs ?? [];
    const online = peer.Online !== false && peer.Active !== false;
    const role = isSelf
      ? 'self'
      : (peer.ExitNode || peer.ExitNodeOption)
        ? 'exit-node'
        : (peer.PrimaryRoutes?.length ? 'subnet-router' : (peer.Tags?.length ? 'tagged' : 'peer'));
    return {
      kind: 'tailscale-node',
      name: host,
      description: `${role} node; online=${online}`,
      endpoint: String(ips[0] || peer.DNSName || host),
      transport: 'tailscale',
      trust: 'untrusted',
      scope: online ? ['read', 'tailnet'] : ['read', 'tailnet', 'offline'],
      source: 'tailscale-status',
      pool,
      tags: peer.Tags ?? [],
      metadata: {
        nodeId: peer.ID,
        hostname: peer.HostName,
        dnsName: peer.DNSName,
        os: peer.OS,
        tailscaleIps: ips,
        online,
        operable: online,
        role
      }
    };
  });
}

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function applyCaptures(path, captures) {
  let out = path;
  for (const [k, v] of Object.entries(captures)) {
    out = out.replaceAll(`:${k}`, encodeURIComponent(String(v)));
  }
  return out;
}

async function httpStep(baseUrl, step, captures) {
  let path = applyCaptures(step.path ?? '/', captures);
  const url = `${baseUrl}${path}`;
  const fetchOpts = {
    method: step.method ?? 'GET',
    signal: AbortSignal.timeout(15_000)
  };
  if (step.body != null && (fetchOpts.method === 'POST' || fetchOpts.method === 'PATCH')) {
    fetchOpts.headers = { 'content-type': 'application/json' };
    fetchOpts.body = JSON.stringify(step.body);
  }
  const res = await request(url, fetchOpts);
  const expectedStatus = step.expectedStatus ?? 200;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }

  if (res.status !== expectedStatus) {
    return {
      ok: false,
      failureType: 'wrong_status',
      details: `expected HTTP ${expectedStatus}, got ${res.status} (${text.slice(0, 180)})`
    };
  }

  for (const [key, expected] of Object.entries(step.bodyEquals ?? {})) {
    if (JSON.stringify(getByPath(body, key)) !== JSON.stringify(expected)) {
      return { ok: false, failureType: 'wrong_value', details: `unexpected response field: ${key}` };
    }
  }

  if (step.bodyContainsField || step.fieldIsArray || step.minArrayLength != null || step.maxArrayLength != null || step.assert) {
    if (body == null || typeof body !== 'object') {
      return { ok: false, failureType: 'parse_error', details: 'response is not JSON' };
    }
    if (step.bodyContainsField && !(step.bodyContainsField in body)) {
      return { ok: false, failureType: 'missing_field', details: `body missing field: ${step.bodyContainsField}` };
    }
    const arrField = step.fieldIsArray || (step.minArrayLength != null || step.maxArrayLength != null || step.assert ? 'capabilities' : null);
    if (arrField) {
      const val = body[arrField];
      if (!Array.isArray(val)) {
        return { ok: false, failureType: 'not_array', details: `field ${arrField} is not an array` };
      }
      if (step.minArrayLength != null && val.length < step.minArrayLength) {
        return { ok: false, failureType: 'array_too_short', details: `${arrField}.length=${val.length} < ${step.minArrayLength}` };
      }
      if (step.maxArrayLength != null && val.length > step.maxArrayLength) {
        return { ok: false, failureType: 'array_too_long', details: `${arrField}.length=${val.length} > ${step.maxArrayLength}` };
      }
      if (step.assert === 'tailscaleInventoryShape') {
        const nodes = val.filter((c) => c.kind === 'tailscale-node');
        if (nodes.length < (step.minArrayLength ?? 1)) {
          return { ok: false, failureType: 'assert', details: `expected ≥${step.minArrayLength ?? 1} tailscale-node cards` };
        }
        const offline = nodes.filter((c) => c.metadata?.online === false || (Array.isArray(c.scope) && c.scope.includes('offline')));
        if (offline.length < 1) {
          return { ok: false, failureType: 'assert', details: 'expected ≥1 offline node from fixture' };
        }
        const badOperable = offline.filter((c) => c.metadata?.operable === true);
        if (badOperable.length > 0) {
          return { ok: false, failureType: 'assert', details: `offline nodes must not be operable: ${badOperable.map((c) => c.name).join(',')}` };
        }
      }
    }
  }

  if (step.capture && body) {
    for (const [name, dotted] of Object.entries(step.capture)) {
      const v = getByPath(body, dotted);
      if (v == null) {
        return { ok: false, failureType: 'capture_miss', details: `capture ${name} missing at ${dotted}` };
      }
      captures[name] = v;
    }
  }

  return { ok: true, details: `HTTP ${res.status}`, body };
}

async function runActionStep(baseUrl, step) {
  if (step.action === 'seedTailscaleFixture') {
    const candidates = await parseTailscaleFixture(step.fixture || 'tailscale/status.json');
    let created = 0;
    for (const input of candidates) {
      const res = await request(`${baseUrl}/api/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) {
        const t = await res.text();
        return { ok: false, failureType: 'seed_failed', details: `POST capability failed HTTP ${res.status}: ${t.slice(0, 200)}` };
      }
      created += 1;
      await res.text();
    }
    return { ok: true, details: `seeded ${created} tailscale-node cards from fixture` };
  }

  if (step.action === 'seedNCapabilities') {
    const count = Number(step.count ?? 10);
    const kind = step.kind || 'http';
    const pool = step.pool;
    const prefix = step.prefix || 'eval-cap';
    for (let i = 0; i < count; i++) {
      const body = {
        kind,
        name: `${prefix}-${i}`,
        endpoint: kind === 'tailscale-node' ? `100.64.1.${(i % 250) + 1}` : `https://example.invalid/${prefix}-${i}`,
        transport: kind === 'tailscale-node' ? 'tailscale' : 'https',
        trust: 'untrusted',
        source: 'eval',
        pool,
        metadata: kind === 'tailscale-node' ? { online: true, operable: true, nodeId: `${prefix}-${i}` } : undefined
      };
      const res = await request(`${baseUrl}/api/capabilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) {
        const t = await res.text();
        return { ok: false, failureType: 'seed_failed', details: `seedN #${i} HTTP ${res.status}: ${t.slice(0, 160)}` };
      }
      await res.text();
    }
    return { ok: true, details: `seeded ${count} ${kind} capabilities` };
  }

  return { ok: false, failureType: 'unknown_action', details: `unknown action: ${step.action}` };
}

// ── 创建临时 session ────────────────────────────────────────────────────────
async function createTempSession(baseUrl) {
  const res = await request(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', title: 'eval-temp', autoRun: false }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`createTempSession failed: HTTP ${res.status}`);
  const data = await res.json();
  const id = data.session?.id;
  if (!id) throw new Error('createTempSession: missing session.id');
  return id;
}

// ── 执行单个 case ───────────────────────────────────────────────────────────
async function runCase(kase, baseUrl) {
  const start = Date.now();
  const { checks } = kase;
  let failureType = null;
  let details = '';

  try {
    if (checks.type === 'sequence') {
      const captures = {};
      const notes = [];
      for (const step of checks.steps ?? []) {
        if (step.action) {
          const r = await runActionStep(baseUrl, step);
          if (!r.ok) {
            return { status: 'fail', failureType: r.failureType, details: r.details, duration_ms: Date.now() - start };
          }
          notes.push(r.details);
          continue;
        }
        if (step.createSession) {
          captures.newSession = await createTempSession(baseUrl);
        }
        const r = await httpStep(baseUrl, step, captures);
        if (!r.ok) {
          return { status: 'fail', failureType: r.failureType, details: r.details, duration_ms: Date.now() - start };
        }
        notes.push(r.details);
      }
      return { status: 'pass', failureType: null, details: notes.join('; '), duration_ms: Date.now() - start };
    }

    // legacy single HTTP check
    let path = checks.path;
    if (checks.createSession) {
      const sid = await createTempSession(baseUrl);
      path = path.replace(':newSession', sid);
    }

    const step = { ...checks, path };
    const r = await httpStep(baseUrl, step, {});
    if (!r.ok) {
      return { status: 'fail', failureType: r.failureType, details: r.details, duration_ms: Date.now() - start };
    }
    return { status: 'pass', failureType: null, details: r.details, duration_ms: Date.now() - start };
  } catch (e) {
    failureType = 'exception';
    details = e instanceof Error ? e.message : String(e);
  }

  return { status: 'fail', failureType, details, duration_ms: Date.now() - start };
}

// ── 加载 cases ──────────────────────────────────────────────────────────────
function loadCasesFromDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function loadCases(targetMode, caseFilter, grep, targetSuite) {
  let cases = [];
  if (targetSuite) {
    cases = loadCasesFromDir(join(__dirname, 'cases', targetSuite));
  } else {
    cases = loadCasesFromDir(join(__dirname, 'cases', targetMode));
  }
  if (caseFilter) cases = cases.filter((c) => c.id === caseFilter);
  if (grep) {
    const g = grep.toLowerCase();
    cases = cases.filter((c) => String(c.id).toLowerCase().includes(g) || String(c.capability).toLowerCase().includes(g));
  }
  return cases;
}

// ── 输出格式 ────────────────────────────────────────────────────────────────
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';

function statusLabel(s) {
  if (s === 'pass') return PASS;
  if (s === 'fail') return FAIL;
  return SKIP;
}

function printTable(results) {
  const idW = Math.max(6, ...results.map(r => r.case_id.length));
  const capW = Math.max(10, ...results.map(r => r.capability.length));
  const sep = `${'-'.repeat(idW + 2)}-+-${'-'.repeat(capW + 2)}-+--------+---------+--${'-'.repeat(40)}`;
  const hdr = ` ${'CASE ID'.padEnd(idW)} | ${'CAPABILITY'.padEnd(capW)} | STATUS | DURATION | DETAILS`;
  console.log('\n' + sep);
  console.log(hdr);
  console.log(sep);
  for (const r of results) {
    const status = r.status === 'pass' ? PASS : r.status === 'fail' ? FAIL : SKIP;
    const dur = `${r.duration_ms}ms`.padStart(8);
    const details = (r.details ?? '').slice(0, 60);
    console.log(` ${r.case_id.padEnd(idW)} | ${r.capability.padEnd(capW)} | ${status} | ${dur} | ${details}`);
  }
  console.log(sep);
}

// ── 写结果 ───────────────────────────────────────────────────────────────────
function writeResults(results) {
  const outDir = outputDir;
  mkdirSync(outDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const outFile = join(outDir, `${dateStr}.jsonl`);
  for (const r of results) {
    appendFileSync(outFile, JSON.stringify(r) + '\n', 'utf8');
  }
  console.log(`\n[eval] results written to ${outFile}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cases = loadCases(mode, filterCase, grepFilter, suite);
  if (cases.length === 0) {
    console.error(`[eval] no cases found for mode=${mode}${suite ? ` suite=${suite}` : ''}${filterCase ? ` case=${filterCase}` : ''}${grepFilter ? ` grep=${grepFilter}` : ''}`);
    process.exit(1);
  }

  // Remote candidates may contain real state. Only explicitly read-only suites run there.
  if (externalBaseUrl && cases.some(kase => {
    const steps = kase.checks.type === 'sequence' ? kase.checks.steps : [kase.checks];
    return kase.remoteSafe !== true || !steps?.length || steps.some(step =>
      step.action || step.createSession || !['GET', 'HEAD'].includes(step.method ?? 'GET') ||
      !step.path?.startsWith('/api/') || step.path.includes('..'));
  })) throw new Error('remote eval requires remoteSafe read-only cases; use --suite candidate');

  const needDiscovery = cases.some(caseNeedsDiscovery);
  const extraEnv = needDiscovery ? discoveryDaemonEnv() : {};

  console.log(`[eval] mode=${mode}${suite ? ` suite=${suite}` : ''} cases=${cases.length}${filterCase ? ` filter=${filterCase}` : ''}${grepFilter ? ` grep=${grepFilter}` : ''}`);
  if (needDiscovery) {
    console.log(`[eval] discovery env: RAW_AGENT_DISCOVERY=1 TAILSCALE_STATUS_JSON=${TAILSCALE_FIXTURE}`);
  }

  const port = 18_000 + Math.floor(Math.random() * 2000);
  const stateDir = externalBaseUrl ? null : mkdtempSync(join(tmpdir(), 'ppeng-eval-'));
  const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;

  console.log(externalBaseUrl ? `[eval] probing candidate ${baseUrl}` : `[eval] spawning daemon on port ${port} ...`);
  const { child, getStderr } = externalBaseUrl
    ? { child: null, getStderr: () => '' }
    : spawnDaemon({ port, stateDir, extraEnv });

  const results = [];
  let daemonOk = false;

  try {
    await waitForHealth(baseUrl, 25_000);
    daemonOk = true;
    console.log(`[eval] daemon ready at ${baseUrl}\n`);

    for (const kase of cases) {
      process.stdout.write(`  running ${kase.id} ... `);
      const r = await runCase(kase, baseUrl);
      const result = {
        case_id: kase.id,
        evaluation_kind: 'contract',
        target: externalBaseUrl ? 'candidate' : 'ephemeral',
        base_url: baseUrl,
        capability: kase.capability,
        mode: kase.mode,
        status: r.status,
        duration_ms: r.duration_ms,
        failure_type: r.failureType ?? null,
        details: r.details ?? ''
      };
      results.push(result);
      process.stdout.write(`${statusLabel(r.status)} (${r.duration_ms}ms)\n`);
    }
  } catch (e) {
    console.error(`\n[eval] fatal: ${e.message}`);
    if (getStderr().trim()) {
      console.error('[eval] daemon stderr:\n', getStderr().slice(-2000));
    }
    for (const kase of cases) {
      if (!results.find(r => r.case_id === kase.id)) {
        results.push({
          case_id: kase.id,
          capability: kase.capability,
          mode: kase.mode,
          status: 'skip',
          duration_ms: 0,
          failure_type: 'daemon_error',
          details: e.message
        });
      }
    }
  } finally {
    if (child) await killDaemon(child);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }

  printTable(results);
  writeResults(results);

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log(`\n[eval] summary: ${passed} passed, ${failed} failed, ${skipped} skipped / ${results.length} total`);

  if (exitOnFail && (failed > 0 || skipped > 0 || !daemonOk)) {
    process.exit(1);
  } else if (!exitOnFail) {
    process.exit(0);
  }
}

main().catch(e => {
  console.error('[eval] uncaught:', e);
  process.exit(1);
});
