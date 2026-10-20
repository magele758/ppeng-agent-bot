#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson } from './http-auth.mjs';
import { candidateEvidence, setGate } from './report-builder.mjs';
import { truthy } from './config.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetchJson(`${baseUrl}/api/health`);
      if (res.ok && res.data?.ok === true) return res.data;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`health timeout: ${lastErr?.message ?? 'unknown'}`);
}

function runCmd(cmd, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: sanitizeScriptEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.once('exit', (code) => resolve({ code: code ?? 1, out }));
    child.once('error', (e) => resolve({ code: 1, out: e.message }));
  });
}

export async function runG0(repoRoot, report) {
  const failures = [];
  const revision = await runCmd('git', ['rev-parse', 'HEAD'], repoRoot);
  if (revision.code !== 0 || !candidateEvidence(report, true) || revision.out.trim() !== report.candidate.git_sha) {
    failures.push('source revision does not match candidate deployment; deploy the intended revision before G0');
    setGate(report, 'g0', 'fail', failures[0]);
    return { ok: false, failures };
  }
  const build = spawnSync('pnpm', ['run', 'build'], { cwd: repoRoot, env: sanitizeScriptEnv(), encoding: 'utf8', shell: true });
  if (build.status !== 0) failures.push('pnpm run build failed');

  const unit = spawnSync('pnpm', ['run', 'test:unit'], { cwd: repoRoot, env: sanitizeScriptEnv(), encoding: 'utf8', shell: true });
  if (unit.status !== 0) failures.push('pnpm run test:unit failed');

  if (truthy(process.env.EVOLUTION_HARNESS_GATE)) {
    const harness = await runCmd(process.execPath, ['scripts/agent-eval/runner.mjs', '--mode', 'fast', '--exit-on-fail'], repoRoot);
    if (harness.code !== 0) failures.push('harness fast eval failed');
  }

  const status = failures.length ? 'fail' : 'pass';
  setGate(report, 'g0', status, failures.join('; ') || 'unit+build ok');
  return { ok: failures.length === 0, failures };
}

export async function runG1(cfg, report, execute = runCmd) {
  const failures = [];
  const daemonUrl = cfg.candidateDaemonUrl;
  if (!daemonUrl) {
    failures.push('missing EVOLUTION_RELEASE_CANDIDATE_DAEMON_URL');
  } else {
    try {
      await waitForHealth(daemonUrl);
      const ready = await fetchJson(`${daemonUrl}/api/readiness`);
      if (!ready.ok || ready.data?.ready !== true) failures.push(`readiness rejected (HTTP ${ready.status})`);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (!failures.length) {
    const evalRes = await execute(process.execPath, [
      'scripts/agent-eval/runner.mjs', '--suite', 'candidate', '--base-url', daemonUrl, '--exit-on-fail'
    ], cfg.repoRoot);
    if (evalRes.code !== 0) failures.push('candidate contract eval failed');
  }

  const status = failures.length ? 'fail' : 'pass';
  setGate(report, 'g1', status, failures.join('; ') || 'candidate probes + eval ok');
  return { ok: failures.length === 0, failures };
}

export async function runG2(cfg, report) {
  if (cfg.skipG2) {
    setGate(report, 'g2', 'skip', 'EVOLUTION_RELEASE_SKIP_G2=1');
    return { ok: true, skipped: true };
  }

  const failures = [];
  const env = sanitizeScriptEnv({
    ...process.env,
    REGRESSION_DAEMON_URL: cfg.candidateDaemonUrl,
    INTEGRATION_DAEMON_URL: cfg.candidateDaemonUrl,
    PLAYWRIGHT_BASE_URL: cfg.candidateWebUrl
  });

  if (!cfg.candidateDaemonUrl || !cfg.candidateWebUrl) {
    failures.push('missing candidate URLs');
  } else {
    try {
      await waitForHealth(cfg.candidateDaemonUrl);
      const web = await fetch(`${cfg.candidateWebUrl}/`, { signal: AbortSignal.timeout(15_000) });
      if (!web.ok) throw new Error(`web HTTP ${web.status}`);
    } catch (e) {
      failures.push(`candidate unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!failures.length) {
    const reg = spawnSync('pnpm', ['run', 'test:regression'], { cwd: cfg.repoRoot, env, encoding: 'utf8', shell: true });
    if (reg.status !== 0) failures.push('test:regression failed');
  }
  if (!failures.length) {
    const it = spawnSync('pnpm', ['run', 'test:integration'], { cwd: cfg.repoRoot, env, encoding: 'utf8', shell: true });
    if (it.status !== 0) failures.push('test:integration failed');
  }
  if (!failures.length && existsSync(join(cfg.repoRoot, 'apps', 'web-console', '.next', 'BUILD_ID'))) {
    const e2e = spawnSync('pnpm', ['run', 'test:e2e'], { cwd: cfg.repoRoot, env, encoding: 'utf8', shell: true });
    if (e2e.status !== 0) failures.push('test:e2e failed');
  } else if (!failures.length) {
    failures.push('web-console not built; skip e2e or run build:web-console first');
  }

  report.observation = report.observation ?? {};
  report.observation.e2e_url = cfg.candidateWebUrl;
  const status = failures.length ? 'fail' : 'pass';
  setGate(report, 'g2', status, failures.join('; ') || 'regression+integration+e2e ok');
  report.observation.bake_started_at = failures.length ? '' : new Date().toISOString();
  return { ok: failures.length === 0, failures };
}

export function bakeElapsedHours(report) {
  const start = report.observation?.bake_started_at;
  if (!start) return 0;
  return (Date.now() - Date.parse(start)) / (3600 * 1000);
}

export function runG3(cfg, report) {
  const bakeOk = bakeElapsedHours(report) >= cfg.bakeHours;
  const failures = [];
  for (const key of ['g0', 'g1', 'g2']) {
    if (report.gates?.[key] !== 'pass') failures.push(`${key}=${report.gates?.[key]}`);
    const expected = candidateEvidence(report, key === 'g0');
    if (!expected || report.gate_evidence?.[key] !== expected) failures.push(`${key} evidence does not match current candidate deployment`);
  }
  if (!report.candidate?.git_sha || !report.candidate?.image_tags?.daemon || !report.candidate?.image_tags?.web) {
    failures.push('missing candidate revision or immutable image tags');
  }
  if (Object.values(report.candidate?.image_tags ?? {}).some(tag => ['latest', 'nightly', 'candidate', 'stable'].includes(tag))) {
    failures.push('mutable image alias cannot be promoted');
  }
  if (cfg.backend === 'compose' && !['daemon', 'web'].every(role => /^sha256:[a-f0-9]{64}$/.test(report.candidate?.image_ids?.[role] ?? ''))) {
    failures.push('missing verified compose image IDs');
  }
  if (cfg.backend === 'helm' && !['daemon', 'web'].every(role => /^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(report.candidate?.image_refs?.[role] ?? ''))) {
    failures.push('missing verified Helm image digests');
  }
  if (!bakeOk) failures.push(`bake ${bakeElapsedHours(report).toFixed(1)}h < ${cfg.bakeHours}h`);
  const status = failures.length ? 'fail' : 'pass';
  setGate(report, 'g3', status, failures.join('; ') || 'bake+promote ready');
  return { ok: failures.length === 0, failures };
}
