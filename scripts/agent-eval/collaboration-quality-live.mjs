/** Explicit, isolated live-model delivery trial. No credentials or live Bot state are written. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RawAgentRuntime, createModelAdapterFromEnv, sanitizeSpawnEnv } from '../../packages/core/dist/exports/public.js';
import { configuredModel } from './configured-model.mjs';

const [settingsRoot, botId, output] = process.argv.slice(2);
if (!output) throw Error('Usage: node scripts/agent-eval/collaboration-quality-live.mjs <settings-root> <configured-bot-id> <new-output-directory>');
const dir = resolve(output);
mkdirSync(dirname(dir), { recursive: true });
mkdirSync(dir, { recursive: false });
const config = await configuredModel(settingsRoot, botId, process.cwd());
const model = createModelAdapterFromEnv({ ...config.env, RAW_AGENT_MODEL_PROVIDER: config.model.provider, RAW_AGENT_OPENAI_HTTP_KIND: config.model.httpKind, RAW_AGENT_USE_JSON_MODE: '0' });
const testSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './totals.mjs';
test('integer cents grouped and sorted', () => assert.deepEqual(summarize([{account:'b',cents:250},{account:'a',cents:100},{account:'b',cents:-50}]),[{account:'a',cents:100},{account:'b',cents:200}]));
test('empty input', () => assert.deepEqual(summarize([]), []));
test('fractional cents rejected', () => assert.throws(() => summarize([{account:'a',cents:1.5}])));
test('unsafe integers rejected', () => assert.throws(() => summarize([{account:'a',cents:Infinity}])));
test('overflow rejected', () => assert.throws(() => summarize([{account:'a',cents:Number.MAX_SAFE_INTEGER},{account:'a',cents:1}])));
`;
writeFileSync(dir + '/acceptance.test.mjs', testSource);
writeFileSync(dir + '/.gitignore', 'state/\nevidence*.json\n*.log\n');
for (const args of [
  ['init', '--initial-branch=main'], ['config', 'user.name', 'Agent verification'],
  ['config', 'user.email', 'verification@localhost'], ['add', 'acceptance.test.mjs', '.gitignore'],
  ['commit', '-m', 'test: establish immutable delivery acceptance fixture']
]) {
  const result = spawnSync('git', args, { cwd: dir, env: sanitizeSpawnEnv(process.env), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || 'Cannot prepare isolated Git fixture');
}
const hash = text => createHash('sha256').update(text).digest('hex');
const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: dir + '/state', modelAdapter: model });
// This explicit trial authorizes local test execution only in its isolated runtime.
const createSession = rt.store.createSession.bind(rt.store);
rt.store.createSession = (...args) => {
  const session = createSession(...args);
  rt.store.setDaemonControl('source-policy:' + session.id, { allowedEffects: ['work_evidence'] });
  return session;
};
rt.store.setDaemonControl('sandbox_settings', { mode: 'direct' });
rt.store.setDaemonControl('loop_settings', { kernelVariant: 'agent-loop', repeatGuard: 'weak' });
const title = 'Implement totals.mjs exporting summarize(rows): group {account,cents} by account, sort accounts ascending, sum integer cents including negatives; empty input returns []; reject non-safe-integer cents and unsafe summed totals. Read acceptance.test.mjs, implement only totals.mjs, and run node --test acceptance.test.mjs. Do not edit the acceptance test. For this reproducible acceptance trial, independent test stages must execute work_evidence with verify_command exactly "node --test acceptance.test.mjs". Do not combine it with ad-hoc probes, Git commands or shell assertions. The host separately verifies fixture integrity and Git baseline; exploratory test proposals may be reported without executing them.';
const store = rt.store.orchestrator();
const run = store.createRun({ title, sourceType: 'live-quality-trial', sourceRef: 'acceptance.test.mjs' });
for (const stage of ['implement', 'review', 'test']) store.createStep({ runId: run.id, stage, executor: stage, status: 'pending' });
const evidence = { model: config.selection, startedAt: new Date().toISOString(), runId: run.id, outcome: 'running' };
const save = () => {
  const swarms = rt.store.swarm().listRuns();
  writeFileSync(dir + '/evidence.json', JSON.stringify({ ...evidence, orchestration: store.getRun(run.id), steps: store.listSteps(run.id), events: store.listEvents(run.id), swarms: swarms.map(s => ({ ...s, tasks: rt.store.swarm().listTasks(s.id), reviews: rt.store.swarm().listReviews(s.id) })), sessions: rt.store.listSessions().map(s => ({ session: s, messages: rt.store.foldMessages(s.id) })) }, null, 2));
};
const deadline = setTimeout(() => { evidence.outcome = 'timeout'; for (const s of rt.store.listSessions()) if (rt.isSessionRunning(s.id)) rt.cancelSession(s.id); }, 900_000);
try {
  for (let i = 0; i < 900; i++) {
    await rt.runScheduler();
    save();
    const status = store.getRun(run.id).status;
    console.log(JSON.stringify({ status, steps: store.listSteps(run.id).map(s => [s.stage, s.status]), sessions: rt.store.listSessions().map(s => [s.id, s.status, s.metadata?.qualityStage]) }));
    if (['completed', 'failed', 'blocked'].includes(status)) break;
    if (evidence.outcome === 'timeout') throw Error('Live trial timed out');
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(store.getRun(run.id).status, 'completed', 'Delivery must pass both Swarm and Orchestrator gates');
  assert.equal(hash(readFileSync(dir + '/acceptance.test.mjs', 'utf8')), hash(testSource), 'Acceptance fixture must remain unchanged');
  const fixtureDiff = spawnSync('git', ['diff', '--exit-code', 'HEAD', '--', 'acceptance.test.mjs'], { cwd: dir, env: sanitizeSpawnEnv(process.env), encoding: 'utf8', timeout: 30000 });
  assert.equal(fixtureDiff.status, 0, 'Git acceptance baseline must remain unchanged');
  const actual = spawnSync(process.execPath, ['--test', 'acceptance.test.mjs'], { cwd: dir, env: sanitizeSpawnEnv(process.env), encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000 });
  writeFileSync(dir + '/independent-tests.log', actual.stdout + actual.stderr);
  assert.equal(actual.status, 0, 'Operator independently executes the delivered artifact');
  evidence.outcome = 'pass';
  evidence.testFixtureSha256 = hash(testSource);
  evidence.operatorTestExitCode = actual.status;
  evidence.operatorFixtureDiffExitCode = fixtureDiff.status;
  console.log('PASS: live implementation, independent review, actual test execution, persisted quality gates, independent operator verification');
} catch (error) {
  evidence.outcome = 'fail'; evidence.error = String(error); process.exitCode = 1;
  console.error(String(error));
} finally {
  clearTimeout(deadline); evidence.finishedAt = new Date().toISOString(); save();
  for (const s of rt.store.listSessions()) if (rt.isSessionRunning(s.id)) rt.cancelSession(s.id);
  await rt.destroy();
}
