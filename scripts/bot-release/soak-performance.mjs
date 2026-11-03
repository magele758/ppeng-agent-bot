import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { PERFORMANCE_SPAWN_TIMEOUT_MS, SHARED_RUNNER_SMOKE_DRAIN_SECONDS } from './http-fixture-timing.mjs';

const workload = JSON.parse(readFileSync(new URL('./workload.v1.json', import.meta.url), 'utf8'));

export function performanceEnv(base = process.env) {
  const env = sanitizeScriptEnv(base);
  delete env.NODE_V8_COVERAGE;
  return env;
}

/** Shared-runner p95. The published SLO stays on the local profile; this only bounds a multi-second stall. */
const SHARED_RUNNER_P95_MS = 8000;

export function performanceResult(report, profile = 'local') {
  if (!['local', 'github-actions'].includes(profile)) throw new Error(`Unknown performance profile: ${profile}`);
  const checks = ['page', 'search', 'status', 'receive'].map(name => {
    const sample = report?.latency?.[name];
    const thresholdMs = profile === 'github-actions' ? SHARED_RUNNER_P95_MS : workload.thresholdsMs[`${name}P95`];
    return { name, count: sample?.count ?? 0, p95Ms: sample?.p95Ms ?? null, thresholdMs,
      passed: Number.isFinite(sample?.count) && sample.count > 0 && Number.isFinite(sample?.p95Ms) && sample.p95Ms >= 0 && sample.p95Ms <= thresholdMs };
  });
  return { profile, passed: report?.status === 'completed' && report?.fixturePassed === true && checks.every(check => check.passed),
    checks, fullSoakAccepted: false,
    limitation: 'Compressed HTTP workload performance only; not full-duration soak or release acceptance.' };
}

export function performanceSoakArgs(profile, reportPath) {
  if (!['local', 'github-actions'].includes(profile)) throw new Error(`Unknown performance profile: ${profile}`);
  const soakArgs = ['scripts/bot-release/http-soak.mjs', '--smoke', '--out', reportPath];
  // 2 reads/s with a deeper queue, and a drain long enough for result-notification turns
  // after the offered work is already terminal. 90s stays inside the 180s process budget.
  if (profile === 'github-actions') soakArgs.push('--read-every-ms', '500', '--read-queue-cap', '40', '--drain-seconds', String(SHARED_RUNNER_SMOKE_DRAIN_SECONDS));
  return soakArgs;
}

export function runPerformance({ directory = 'test-results/soak-performance', profile = 'local' } = {}) {
  performanceResult(undefined, profile);
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const reportPath = join(output, 'http-soak.json');
  rmSync(reportPath, { force: true });
  const child = spawnSync(process.execPath, performanceSoakArgs(profile, reportPath), {
    env: performanceEnv(), stdio: 'inherit', timeout: PERFORMANCE_SPAWN_TIMEOUT_MS
  });
  let report;
  let error = child.error?.message;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch (failure) { error ??= failure.message; }
  const summary = { ...performanceResult(report, profile), candidate: report?.candidate, workloadHash: report?.workloadHash,
    hardware: report?.hardware, exitCode: child.status, error };
  summary.passed = summary.passed && child.status === 0 && !error;
  writeFileSync(join(output, 'performance.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--profile')) throw new Error('Usage: soak-performance.mjs [--profile local|github-actions]');
  process.exitCode = runPerformance({ profile: args[1] ?? 'local' }).passed ? 0 : 1;
}
