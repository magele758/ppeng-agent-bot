import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { runWithCleanup } from '../e2e-lifecycle.mjs';
import { runIsolatedLab } from '../e2e-run.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { compareRounds } from './comparison.mjs';

const { values } = parseArgs({ options: {
  'base-url': { type: 'string' },
  rounds: { type: 'string', default: '3' }, 'time-limit': { type: 'string', default: '90s' }
} });
const existing = values['base-url'] ? new URL(values['base-url']) : null;
if (existing && (!['http:', 'https:'].includes(existing.protocol) || existing.username || existing.password)) {
  throw new Error('Expected an HTTP(S) Lab origin without embedded credentials');
}
const count = Number(values.rounds);
if (!Number.isSafeInteger(count) || count < 1 || count > 30) throw new Error('Expected --rounds 1..30');
if (!/^[1-9]\d*[smh]$/.test(values['time-limit'])) throw new Error('Expected a positive --time-limit such as 90s');
const root = resolve('test-results/bombadil');
mkdirSync(root, { recursive: true });
const output = mkdtempSync(join(root, 'comparison-'));
const playwright = createRequire(import.meta.url).resolve('@playwright/test/cli');
const result = { target: existing?.origin ?? 'isolated-lab', requestedRounds: count, explorationBudget: values['time-limit'], rounds: [], calibrated: false, calibration: null, comparison: { status: 'incomplete' } };
function persist() {
  writeFileSync(join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log('Benchmark report:', join(output, 'report.json'));
persist();

async function fixed(registry, base, directory) {
  const env = sanitizeScriptEnv({ ...process.env, PLAYWRIGHT_BASE_URL: base, PLAYWRIGHT_FONT_COMPARISON_DIR: directory });
  if (process.env.CHROME) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = process.env.CHROME;
  const code = await registry.spawnTask(process.execPath, [playwright, 'test', 'e2e/font-size-preference.spec.ts',
    '--retries=0', '--workers=1', '--reporter=line', '--output', join(directory, 'playwright')], { env });
  const meters = readdirSync(directory).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')));
  return { status: code === 0 && meters.length === 4 && meters.every(m => !m.violation && m.cells.length) ? 'passed' : 'failed',
    code, testsObserved: meters.length, cells: [...new Set(meters.flatMap(m => m.cells))], latencies: meters.flatMap(m => m.latencies) };
}

async function random(registry, base, directory, canary) {
  const url = base + (canary ? '/?fontCanary=1' : '/') + '#/settings/general';
  const code = await registry.spawnTask('bombadil', ['browser', 'test', '--headless', '--width', '1280', '--height', '900',
    '--time-limit', values['time-limit'], '--exit-on-violation', '--output-path', directory,
    url, 'scripts/bombadil/font-settings.ts'], { env: sanitizeScriptEnv() });
  const trace = join(directory, 'trace.jsonl');
  if (!existsSync(trace)) return { status: 'failed', code, reason: 'No browser trace' };
  let last;
  let observedCanary = false;
  const findings = new Set();
  const lines = createInterface({ input: createReadStream(trace), crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = JSON.parse(line);
    for (const snapshot of entry.snapshots) {
      const meter = snapshot.value?.meter;
      if (Array.isArray(meter?.cells)) last = meter;
      if (snapshot.value?.injected && meter?.violation?.endsWith('/1px')) observedCanary = true;
    }
    for (const finding of entry.violations) findings.add(finding.name);
  }
  const cells = last?.cells ?? [];
  const passed = canary ? code === 2 && observedCanary && findings.has('fontPreviewMatches') :
    code === 0 && !findings.size && cells.length >= 2 && last?.latencies.length > 0;
  return { status: passed ? 'passed' : 'failed', code, cells, latencies: last?.latencies ?? [], findings: [...findings] };
}

async function measure(kind, round) {
  const directory = join(output, round + '-' + kind);
  mkdirSync(directory);
  let sample = { status: 'setup-failed', reason: 'Lab did not become ready' };
  const code = await runWithCleanup(async registry => {
    const test = async ({ PLAYWRIGHT_BASE_URL: base }) => {
      const start = performance.now();
      sample = kind === 'baseline' ? await fixed(registry, base, directory) :
        await random(registry, base, directory, kind === 'canary');
      sample.elapsedMs = performance.now() - start;
      return sample.status === 'passed' ? 0 : 1;
    };
    try {
      if (existing) return await test({ PLAYWRIGHT_BASE_URL: existing.origin });
      return await runIsolatedLab(registry, test);
    } catch (error) {
      sample = { status: 'failed', reason: error.message, errorCode: error.code };
      throw error;
    }
  });
  return { ...sample, runnerExitCode: code };
}

async function runComparison() {
  if (existing) {
    try {
      const health = await fetch(new URL('/api/health', existing.origin), { signal: AbortSignal.timeout(4000) });
      if (!health.ok || (await health.json()).ok !== true) throw new Error('Lab health check failed: ' + health.status);
    } catch (error) {
      const cause = error.cause;
      const detail = cause?.errors?.map(attempt => attempt.message).join(' / ');
      result.preflightError = detail || cause?.message || cause?.code || error.message;
      return;
    }
  }
  result.calibration = await measure('canary', 0);
  result.calibrated = result.calibration.status === 'passed';
  persist();
  for (let i = 0; i < count; i++) {
    const trial = {};
    result.rounds.push(trial);
    for (const kind of i % 2 ? ['exploration', 'baseline'] : ['baseline', 'exploration']) {
      trial[kind] = await measure(kind, i + 1);
      persist();
    }
    if (!result.calibrated || trial.baseline.status !== 'passed' || trial.exploration.status !== 'passed') break;
  }
  result.comparison = compareRounds(result.rounds, result.calibrated);
}
await runComparison();
persist();
console.log(JSON.stringify(result, null, 2));
if (result.comparison.status !== 'complete') process.exitCode = 1;
