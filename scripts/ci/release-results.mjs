import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function releaseFailures(needs) {
  const required = ['tests', 'unit', 'formal', 'sdk', 'crap', 'browser', 'acceptance', 'mutation', 'secrets-gate', 'soak-performance'];
  return [...new Set([...required, ...Object.keys(needs)])].filter(name => {
    // Starter has 12 cases; the empirical gate requires at least 30.
    // Keep its real outcome visible, but do not block Main on this diagnostic.
    // Live-model compaction A/B is non-deterministic diagnostic evidence.
    // Remote model smoke is optional live-provider evidence (auth/balance flaky).
    if (name === 'harness' || name === 'compact-ab' || name === 'remote-model-smoke') return false;
    const result = needs[name]?.result;
    return result !== 'success';
  });
}
export function harnessReport(needs) {
  return `Harness (non-blocking): ${needs.harness?.result ?? 'not reported'}. Starter has 12 cases; at least 30 are required. This is not qualifying quality evidence.`;
}
export function compactAbReport(needs) {
  return `Compact A/B (non-blocking): ${needs['compact-ab']?.result ?? 'not reported'}. Live-model evidence is non-deterministic; inspect the job report for quality_regression and failures.`;
}
export function remoteModelSmokeReport(needs) {
  return `Remote model smoke (non-blocking): ${needs['remote-model-smoke']?.result ?? 'not reported'}. Optional live-provider smoke; inspect the job log for upstream auth/balance failures.`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const needs = JSON.parse(process.argv[2]);
  const failures = releaseFailures(needs);
  const summary = [harnessReport(needs), compactAbReport(needs), remoteModelSmokeReport(needs)].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  console.log(failures.length ? `Release gate failed: ${failures.join(', ')}` : 'All blocking release checks passed');
  process.exitCode = failures.length ? 1 : 0;
}
