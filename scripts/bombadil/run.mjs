import { createReadStream, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { runWithCleanup } from '../e2e-lifecycle.mjs';
import { runIsolatedLab } from '../e2e-run.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { canaryDetected, summarizeTrace } from './trace.mjs';
import { botNames, historyMarker, verifyDelivery } from './scenario.mjs';

const { values } = parseArgs({ options: {
  'time-limit': { type: 'string', default: '90s' },
  canary: { type: 'boolean', default: false }
} });

async function api(base, path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(path + ' returned ' + response.status);
  return response.json();
}

async function seed(base) {
  const fixtures = [];
  for (const name of botNames) {
    const { bot } = await api(base, '/api/bots', { name });
    const path = '/api/sessions/' + encodeURIComponent(bot.canonicalSessionId);
    await api(base, path + '/messages', { message: historyMarker(name), autoRun: false });
    if (values.canary) {
      const other = botNames.find(candidate => candidate !== name);
      await api(base, path + '/messages', { message: historyMarker(other), autoRun: false });
    }
    fixtures.push({ name, path });
  }
  return fixtures;
}

process.exitCode = await runWithCleanup(async registry => {
  const env = sanitizeScriptEnv();
  const version = await registry.spawnTask('bombadil', ['--version'], { env });
  if (version !== 0) throw new Error('Install Bombadil v0.7.10 on PATH to run this pilot.');
  if (!existsSync('apps/web-console/.next/BUILD_ID')) {
    throw new Error('Build the workspace and production Lab first with pnpm run build.');
  }
  return runIsolatedLab(registry, async ({ PLAYWRIGHT_BASE_URL: base }) => {
    const fixtures = await seed(base);
    const root = 'test-results/bombadil';
    mkdirSync(root, { recursive: true });
    const output = mkdtempSync(join(root, values.canary ? 'canary-' : 'run-'));
    console.log('[bombadil] trace directory:', output);
    const code = await registry.spawnTask('bombadil', [
      'browser', 'test', '--headless', '--width', '1440', '--height', '960', '--exit-on-violation', '--time-limit', values['time-limit'],
      '--output-path', output, base + '/#/bot', 'scripts/bombadil/bot-switch.ts'
    ], { env });
    if (code !== 0 && code !== 2) return code;
    const file = join(output, 'trace.jsonl');
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    const report = await summarizeTrace(lines);
    console.log('[bombadil] exploration:', report);
    if (values.canary) {
      if (!canaryDetected(code, report)) {
        throw new Error('Canary failed: expected a transcriptOwnership finding; exit=' + code);
      }
      console.log('[bombadil] canary detected the seeded cross-Bot message');
      return 0;
    }
    if (code !== 0) return code;
    if (!report.selections || !report.sends) throw new Error('Insufficient UI action coverage');
    for (const { name, path } of fixtures) {
      const { messages } = await api(base, path);
      console.log('[bombadil] delivery:', verifyDelivery(name, messages));
    }
    return 0;
  });
});
