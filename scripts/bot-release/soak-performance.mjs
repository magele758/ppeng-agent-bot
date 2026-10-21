import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const workload = JSON.parse(readFileSync(new URL('./workload.v1.json', import.meta.url), 'utf8'));

export function performanceEnv(base = process.env) {
  const env = sanitizeScriptEnv(base);
  delete env.NODE_V8_COVERAGE;
  return env;
}

export function performanceResult(report) {
  const checks = ['page', 'search', 'status', 'receive'].map(name => {
    const sample = report?.latency?.[name];
    const thresholdMs = workload.thresholdsMs[`${name}P95`];
    return { name, count: sample?.count ?? 0, p95Ms: sample?.p95Ms ?? null, thresholdMs,
      passed: Number.isFinite(sample?.count) && sample.count > 0 && Number.isFinite(sample?.p95Ms) && sample.p95Ms >= 0 && sample.p95Ms <= thresholdMs };
  });
  return { passed: report?.status === 'completed' && report?.fixturePassed === true && checks.every(check => check.passed),
    checks, fullSoakAccepted: false,
    limitation: 'Compressed HTTP workload performance only; not full-duration soak or release acceptance.' };
}

export function runPerformance({ directory = 'test-results/soak-performance' } = {}) {
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const reportPath = join(output, 'http-soak.json');
  rmSync(reportPath, { force: true });
  const child = spawnSync(process.execPath, ['scripts/bot-release/http-soak.mjs', '--smoke', '--out', reportPath], {
    env: performanceEnv(), stdio: 'inherit', timeout: 180_000
  });
  let report;
  let error = child.error?.message;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch (failure) { error ??= failure.message; }
  const summary = { ...performanceResult(report), candidate: report?.candidate, workloadHash: report?.workloadHash,
    hardware: report?.hardware, exitCode: child.status, error };
  summary.passed = summary.passed && child.status === 0 && !error;
  writeFileSync(join(output, 'performance.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runPerformance().passed ? 0 : 1;
}
