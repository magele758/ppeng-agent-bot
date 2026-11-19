import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { formatSummary, metricValue, runScenarios } from './gate.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--browser')) {
  throw new Error('Usage: node scripts/lab-performance/run.mjs [--browser]');
}
const browser = args.includes('--browser');
const git = args => execFileSync('git', args, {env: sanitizeScriptEnv(), encoding: 'utf8'}).trim();
const revision = git(['rev-parse', 'HEAD']);
const budget = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
const metadata = {
  workloadVersion: budget.version, referenceRun: budget.referenceRun, measuredAt: new Date().toISOString(), browser,
  node: process.version, platform: process.platform, arch: process.arch,
  dirty: Boolean(git(['status', '--porcelain'])),
};
const directory = 'test-results/lab-performance';
const output = join(directory, 'report.json');
mkdirSync(directory, {recursive: true});
const report = await runScenarios(revision, [
  {name:'history', budgets:budget.history, measure:async () => (await import('./idle-history.mjs')).runIdleHistory()},
  {name:'sessions', budgets:budget.sessions, measure:async () => (await import('./session-start.mjs')).runSessionStart()},
  {name:'homepage', budgets:budget.homepage.concat(browser ? budget.browser : []),
    measure:async () => (await import('./homepage.mjs')).runHomepage({browser})},
], partial => {
  writeFileSync(output + '.tmp', JSON.stringify({...metadata, ...partial}, null, 2) + '\n');
  renameSync(output + '.tmp', output);
});
const summary = formatSummary(report);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.env.GITHUB_ACTIONS) {
  for (const scenario of report.scenarios) {
    for (const metric of scenario.metrics.filter(item => item.warning)) {
      console.log(`::warning title=Lab performance (${scenario.name})::${metric.name} measured ${metricValue(metric)} ms, reference ${metric.reference} ms, maximum ${metric.max} ms`);
    }
  }
}
if (!report.passed) {
  if (process.env.GITHUB_ACTIONS) {
    for (const scenario of report.scenarios.filter(item => !item.passed)) {
      const failures = scenario.metrics.filter(metric => !metric.passed).map(metric =>
        `${metric.name} measured ${metricValue(metric)}, maximum ${metric.max} ${metric.unit}`);
      const message = [scenario.error, ...failures].filter(Boolean).join(', ');
      console.log(`::error title=Lab performance (${scenario.name})::${message.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')}`);
    }
  }
  process.exitCode = 1;
}
