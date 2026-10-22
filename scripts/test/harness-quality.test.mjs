import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateSuite, gradeTask, compareQuality, pairedSummary, finalAssistantOutput } from '../agent-eval/quality.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const task = (id = 'task', category = 'tools') => ({ id, category, turns: ['save 42 and answer DONE'], expected: { exact: 'DONE', state: { value: 42 }, requiredTools: ['save_result'] } });
const result = () => ({ status: 'idle', output: 'DONE', state: { value: 42 }, toolCalls: [{ name: 'save_result', ok: true }], invariantsOk: true });
const suite = (n = 200) => Array.from({ length: n }, (_, i) => task(`task-${i}`));
const rows = (cases, trials = 3) => cases.flatMap(c => Array.from({ length: trials }, (_, trial) => ['baseline', 'candidate'].map(variant => ({ caseId: c.id, variant, trial, pass: true, tokens: 100, durationMs: 10 }))).flat());

test('final output excludes reasoning and non-text parts without repairing invalid answers', () => {
  const assistant = parts => ({ role: 'assistant', parts });
  const text = value => ({ type: 'text', text: value });
  const reasoning = { type: 'reasoning', text: '{"sum":42}' };
  const c = { ...task(), expected: { json: { sum: 42 } } };
  const output = finalAssistantOutput([
    assistant([text('obsolete answer')]),
    { role: 'user', parts: [text('user content')] },
    assistant([reasoning, text('{"sum":'), { type: 'tool_call', name: 'ignored' }, text('42}')]),
    { role: 'tool', parts: [{ type: 'tool_result', content: 'ignored result' }] }
  ]);
  assert.equal(output, '{"sum":\n42}');
  assert.equal(gradeTask(c, { ...result(), output }).pass, true);
  assert.equal(finalAssistantOutput([]), '');
  assert.equal(finalAssistantOutput([{ role: 'user', parts: [text('not assistant')] }]), '');
  for (const parts of [[reasoning], [], [{ type: 'tool_call', name: 'ignored' }]]) {
    const missing = finalAssistantOutput([assistant([text('{"sum":42}')]), assistant(parts)]);
    assert.equal(missing, '');
    assert.equal(gradeTask(c, { ...result(), output: missing }).pass, false);
  }
  for (const answer of ['```json\n{"sum":42}\n```', '{"sum":41}', 'explanation\n{"sum":42}']) {
    const invalid = finalAssistantOutput([assistant([reasoning, text(answer)])]);
    assert.equal(invalid, answer);
    assert.equal(gradeTask(c, { ...result(), output: invalid }).pass, false);
  }
});

test('outcome grader rejects claimed success without actual side effects or tool execution', () => {
  assert.equal(gradeTask(task(), result()).pass, true);
  assert.equal(gradeTask(task(), { ...result(), state: {} }).pass, false);
  assert.equal(gradeTask(task(), { ...result(), toolCalls: [] }).pass, false);
  assert.equal(gradeTask(task(), { ...result(), invariantsOk: false }).pass, false);
  assert.equal(gradeTask(task(), { ...result(), status: 'waiting_approval' }).pass, false);
});

test('JSON, forbidden tool and call-budget graders are strict', () => {
  const c = { ...task(), expected: { json: { x: 1 }, forbiddenTools: ['save_result'], maxToolCalls: 0 } };
  assert.equal(gradeTask(c, { ...result(), output: '{"x":1}', toolCalls: [] }).pass, true);
  for (const output of ['```json\n{"x":1}\n```', '{"x":1,"extra":2}', '{"x":"1"}']) {
    assert.equal(gradeTask(c, { ...result(), output, toolCalls: [] }).pass, false);
  }
  assert.equal(gradeTask(c, { ...result(), output: '{"x":1}' }).pass, false);
});

test('runtime grading counts rejected known tools and does not double-count executed calls', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-attempts-'));
  try {
    const tasks = join(dir, 'tasks.json'), config = join(dir, 'experiment.json'), out = join(dir, 'results');
    writeFileSync(tasks, JSON.stringify([
      { id: 'blocked', category: 'tools', critical: true, turns: ['Return OK without saving'],
        expected: { exact: 'OK', forbiddenTools: ['save_result'], maxToolCalls: 0 },
        script: [{ tool: 'save_result', input: null }, { text: 'OK' }] },
      { id: 'executed', category: 'tools', turns: ['Save then return OK'],
        expected: { exact: 'OK', requiredTools: ['save_result'], maxToolCalls: 1, state: { answer: 42 } },
        script: [{ tool: 'save_result', input: { key: 'answer', value: 42 } }, { text: 'OK' }] }
    ]));
    writeFileSync(config, JSON.stringify({ suite: tasks, trials: 1, baseline: { repoRoot: resolve('.'), daemonControl: { tool_exposure_settings: { mode: 'full', pinnedGroups: {} } } },
      candidate: { repoRoot: resolve('.'), daemonControl: { tool_exposure_settings: { mode: 'full', pinnedGroups: {} } } }, model: { provider: 'openai-compatible' },
      policy: { maxLatencyRatio: 100 }, limits: { timeoutMs: 10_000 } }));
    const command = spawnSync(process.execPath, ['scripts/agent-eval/compare.mjs', '--config', config, '--simulation', '--out', out], {
      env: sanitizeScriptEnv(), encoding: 'utf8', timeout: 25_000
    });
    assert.equal(command.status, 1, command.stderr + command.stdout);
    for (const variant of ['baseline', 'candidate']) {
      const blocked = JSON.parse(readFileSync(join(out, `blocked-0-${variant}.json`), 'utf8'));
      assert.equal(blocked.pass, false);
      assert.equal(blocked.toolCalls.length, 1);
      assert.equal(blocked.toolCalls[0].name, 'save_result');
      assert.equal(blocked.toolCalls[0].ok, false);
      const executed = JSON.parse(readFileSync(join(out, `executed-0-${variant}.json`), 'utf8'));
      assert.equal(executed.pass, true);
      assert.equal(executed.toolCalls.length, 1);
      assert.equal(executed.toolCalls[0].ok, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no empty, duplicate or ungraded benchmark can pass', () => {
  assert.throws(() => validateSuite([]));
  assert.throws(() => validateSuite([task(), task()]));
  assert.throws(() => validateSuite([{ ...task(), expected: {} }]));
  assert.throws(() => validateSuite([{ ...task(), expected: { exact: 'x', madeUpGrader: true } }]));
});

test('small perfect samples are inconclusive, not evidence of improvement', () => {
  const cases = suite(2);
  const report = compareQuality(cases, rows(cases), { trials: 3 });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.promotionEligible, false);
  assert.ok(report.summary.deltaInterval[0] < 0);
});

test('repeats do not become independent tasks; stable large baseline/candidate can establish non-inferiority', () => {
  const cases = suite();
  const report = compareQuality(cases, rows(cases), { trials: 3 });
  assert.equal(report.verdict, 'non_inferior');
  assert.equal(report.summary.tasks, 200);
  assert.equal(report.promotionEligible, true);
  assert.equal(compareQuality(cases, rows(cases), { trials: 3, simulation: true }).promotionEligible, false);
});

test('critical failures block even when total average increases', () => {
  const cases = suite(); cases[0].critical = true;
  const records = rows(cases);
  records.find(r => r.caseId === cases[0].id && r.variant === 'candidate').pass = false;
  for (const row of records) if (row.variant === 'baseline' && Number(row.caseId.slice(5)) > 150) row.pass = false;
  const report = compareQuality(cases, records, { trials: 3 });
  assert.equal(report.verdict, 'regressed');
  assert.ok(report.regressions.some(r => r.includes('critical')));
});

test('category losses cannot be hidden by wins elsewhere', () => {
  const cases = suite(); cases.slice(0, 10).forEach(c => { c.category = 'rare-important'; });
  const records = rows(cases);
  for (const row of records) if (Number(row.caseId.slice(5)) < 10 && row.variant === 'candidate') row.pass = false;
  const report = compareQuality(cases, records, { trials: 3 });
  assert.equal(report.verdict, 'regressed');
  assert.ok(report.regressions.includes('category regression: rare-important'));
});

test('a pre-existing critical failure blocks release but is not falsely attributed to the candidate change', () => {
  const cases = suite(2); cases[0].critical = true;
  const records = rows(cases).map(r => ({ ...r, pass: r.caseId !== cases[0].id }));
  const report = compareQuality(cases, records, { trials: 3 });
  assert.equal(report.verdict, 'blocked');
  assert.equal(report.regressions.length, 0);
  assert.equal(report.promotionEligible, false);
});

test('missing/duplicate/skipped/infrastructure trials fail closed', () => {
  const cases = suite(2), records = rows(cases);
  for (const invalid of [records.slice(1), [...records, records[0]], records.map((r, i) => i ? r : { ...r, pass: undefined }), records.map((r, i) => i ? r : { ...r, infrastructureError: true })]) {
    assert.equal(compareQuality(cases, invalid, { trials: 3 }).verdict, 'invalid');
  }
});

test('missing usage is not zero cost, cost increases block, weak baselines are inconclusive', () => {
  const cases = suite();
  const missing = rows(cases); missing[0].tokens = null;
  assert.equal(compareQuality(cases, missing, { trials: 3 }).verdict, 'inconclusive');
  const expensive = rows(cases).map(r => ({ ...r, tokens: r.variant === 'candidate' ? 200 : 100 }));
  assert.equal(compareQuality(cases, expensive, { trials: 3 }).verdict, 'regressed');
  const floor = rows(cases).map(r => ({ ...r, pass: false }));
  assert.equal(compareQuality(cases, floor, { trials: 3 }).verdict, 'inconclusive');
});

test('paired reliability compares all repetitions, and widening the comparison family widens uncertainty', () => {
  const pairs = Array.from({ length: 30 }, () => ({ baselineReliable: true, candidateReliable: true, baselineRate: 1, candidateRate: 1 }));
  assert.ok(pairedSummary(pairs, 8).deltaInterval[0] < pairedSummary(pairs, 1).deltaInterval[0]);
  assert.throws(() => compareQuality(suite(1), [], { trials: 3, policy: { minTrials: 0 } }));
  assert.throws(() => compareQuality(suite(1), [], { trials: 3, policy: { unknown: 1 } }));
});

test('full runtime experiment wiring detects an intentionally broken candidate; simulation never authorizes promotion', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-runner-test-'));
  try {
    const tasks = join(dir, 'tasks.json'), config = join(dir, 'experiment.json');
    writeFileSync(tasks, JSON.stringify([{ id: 'contract', category: 'format', critical: true, turns: ['Return OK'], expected: { exact: 'OK' }, script: [{ text: 'OK' }] }]));
    const experiment = { suite: tasks, trials: 1, baseline: { repoRoot: resolve('.') }, candidate: { repoRoot: resolve('.') },
      model: { provider: 'openai-compatible' }, policy: { maxLatencyRatio: 100 }, limits: { timeoutMs: 10_000 } };
    for (const fault of [false, true]) {
      experiment.candidate.simulationFault = fault ? 'wrong-answer' : undefined;
      writeFileSync(config, JSON.stringify(experiment));
      const out = join(dir, fault ? 'broken' : 'control');
      const command = spawnSync(process.execPath, ['scripts/agent-eval/compare.mjs', '--config', config, '--simulation', '--out', out], {
        env: sanitizeScriptEnv(), encoding: 'utf8', timeout: 20_000
      });
      assert.equal(command.status, fault ? 1 : 0, command.stderr + command.stdout);
      const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      assert.equal(report.promotionEligible, false);
      assert.equal(report.verdict, fault ? 'regressed' : 'inconclusive');
      const candidate = JSON.parse(readFileSync(join(out, 'contract-0-candidate.json'), 'utf8'));
      assert.equal(candidate.invariantsOk, true);
      assert.ok(candidate.promptShapes[0].systemHash);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('network adapter experiment actually injects the system appendix and records persisted feature settings', { timeout: 30_000 }, async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer fixture-secret-not-in-report');
    const content = JSON.stringify(body.messages).includes('FORCE_WRONG') ? 'WRONG' : 'OK';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Private reasoning, not the final answer.', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }));
  const dir = mkdtempSync(join(tmpdir(), 'quality-network-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = join(dir, 'tasks.json'), config = join(dir, 'config.json'), out = join(dir, 'report');
  writeFileSync(tasks, JSON.stringify([{ id: 'network', category: 'format', critical: true, turns: ['Return OK'], expected: { exact: 'OK' } }]));
  writeFileSync(config, JSON.stringify({ suite: tasks, trials: 1, baseline: { repoRoot: resolve('.') },
    candidate: { repoRoot: resolve('.'), systemAppendix: 'FORCE_WRONG', daemonControl: { loop_settings: { kernelVariant: 'agent-loop' } } },
    model: { provider: 'openai-compatible', name: 'fixture-network', baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
    policy: { maxLatencyRatio: 100 }, limits: { timeoutMs: 10_000 } }));
  const exit = await new Promise(resolveExit => {
    const child = spawn(process.execPath, ['scripts/agent-eval/compare.mjs', '--config', config, '--out', out], {
      env: sanitizeScriptEnv({ ...process.env, RAW_AGENT_API_KEY: 'fixture-secret-not-in-report' }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    child.once('exit', code => resolveExit({ code, log })); child.once('error', e => resolveExit({ code: 99, log: e.message }));
  });
  assert.equal(exit.code, 1, exit.log);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.temperature === 0 && r.max_tokens === 2048));
  const candidate = JSON.parse(readFileSync(join(out, 'network-0-candidate.json'), 'utf8'));
  const baseline = JSON.parse(readFileSync(join(out, 'network-0-baseline.json'), 'utf8'));
  assert.deepEqual(candidate.savedSettings.loop_settings, { kernelVariant: 'agent-loop' });
  assert.notEqual(candidate.promptShapes[0].systemHash, baseline.promptShapes[0].systemHash);
  assert.equal(candidate.output, 'WRONG');
  assert.equal(candidate.tokens, 22);
  assert.equal(baseline.pass, true);
  assert.ok(baseline.transcript.some(m => m.parts.some(p => p.type === 'reasoning')));
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(report.verdict, 'regressed');
  assert.equal(report.control, false);
  assert.doesNotMatch(readFileSync(join(out, 'manifest.json'), 'utf8'), /fixture-secret-not-in-report/);
});
