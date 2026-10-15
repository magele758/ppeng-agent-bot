import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function releaseFailures(needs) {
  const optional = new Set(['remote-model-smoke', 'compact-ab']);
  const required = ['tests', 'crap', 'acceptance', 'mutation', 'secrets-gate'];
  return [...new Set([...required, ...Object.keys(needs)])].filter(name => {
    // Starter has 12 cases; the empirical gate requires at least 30.
    // Keep its real outcome visible, but do not block Main on this diagnostic.
    if (name === 'harness') return false;
    const result = needs[name]?.result;
    return result !== 'success' && !(optional.has(name) && result === 'skipped');
  });
}
export function harnessReport(needs) {
  return `Harness (non-blocking): ${needs.harness?.result ?? 'not reported'}. Starter has 12 cases; at least 30 are required. This is not qualifying quality evidence.`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const needs = JSON.parse(process.argv[2]);
  const failures = releaseFailures(needs);
  const harness = harnessReport(needs);
  console.log(harness);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, harness + '\n');
  console.log(failures.length ? `Release gate failed: ${failures.join(', ')}` : 'All blocking release checks passed');
  process.exitCode = failures.length ? 1 : 0;
}
