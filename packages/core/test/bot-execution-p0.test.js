import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGoalIntents, classifyGoalMessage } from '../dist/bots/goals/intake.js';
import { selectGoalRoute, goalWorkKind } from '../dist/bots/goals/routing.js';
import { pruneLargeToolOutputs } from '../dist/session/bot-compact-policy.js';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { judgeChildCompletion } from '../dist/bots/goals/runtime-host.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
const capabilities = { registeredTools: ['spawn_subagent'], enabledStrategies: ['direct', 'subagent'] };

test('polite delivery requests keep their objective and execute directly [AC:bot-execution-p0#AC-1]', async () => {
  for (const text of ['帮我实现登录功能', 'Fix the CI pipeline', 'Fix dependency resolution', '帮我实现取消按钮？', 'Could you fix the pause button?', '帮我修复登录功能？', '可以帮我修复登录功能吗？', 'Could you fix login?', 'Please investigate and fix login', '帮我研究并修复登录问题']) {
    assert.equal(classifyGoalMessage(text).kind, 'new_goal', text);
    const route = selectGoalRoute({ task: text }, capabilities);
    assert.equal(route.strategy, 'direct', text);
    assert.equal(route.taskMode, 'auto', text);
  }
  assert.equal(goalWorkKind('Fix the CI pipeline'), 'general');
  assert.equal(goalWorkKind('Fix dependency resolution'), 'general');
  let called = false;
  const text = 'Would you get the login working?';
  const intents = await classifyGoalIntents(text, [], async () => { called = true; return { intents: [{ kind: 'new_goal', text }] }; });
  assert.equal(called, true);
  assert.equal(intents[0].kind, 'new_goal');
});

test('controls stay safe and explicit isolated work cannot fall back to direct [AC:bot-execution-p0#AC-2]', async () => {
  for (const text of ['这个能取消吗？', 'Can I cancel deployment?', '不要取消部署', '解释一下如何暂停']) {
    const intents = await classifyGoalIntents(text, [], async () => ({ intents: [{ kind: 'cancel', text }] }));
    assert.ok(!['pause', 'cancel', 'resume'].includes(intents[0].kind), text);
  }
  for (const text of ['请并行处理这些任务', 'Use subagents to fix login']) {
    assert.equal(selectGoalRoute({ task: text }, capabilities).strategy, 'subagent');
    assert.equal(selectGoalRoute({ task: text }, { ...capabilities, allowedTools: [] }).blocked, true);
  }
  for (const task of ['Do not use subagents to fix login', '不要使用子代理修复登录']) assert.equal(selectGoalRoute({ task }, capabilities).strategy, 'direct');
  const exhausted=selectGoalRoute({ task: 'Fix login' }, { ...capabilities, budgetRemaining: 0 });assert.equal(exhausted.blocked, false);assert.equal(exhausted.strategy, 'direct');
});

test('compaction retains diagnostic tail and structured status without mutating evidence [AC:bot-execution-p0#AC-3]', () => {
  const results = [
    'command: pnpm test\n' + 'compiling...\n'.repeat(1000) + 'TEST RESULT: 3 FAILED\nArtifact: /work/report.xml',
    JSON.stringify({ stdout: 'noise'.repeat(1000), exitCode: 1, stderr: 'assertion failed', artifactPath: '/work/report.xml' })
  ];
  for (const content of results) {
    const original = { sessionId: 's', seq: 3, role: 'tool', parts: [{ type: 'tool_result', toolCallId: 't', name: 'bash', ok: false, content }] };
    const [pruned] = pruneLargeToolOutputs([original]);
    assert.equal(original.parts[0].content, content);
    assert.equal(pruned.parts[0].ok, false);
    assert.ok(pruned.parts[0].content.length < content.length);
    assert.match(pruned.parts[0].content, /report.xml/);
    assert.match(pruned.parts[0].content, /3 FAILED|assertion failed/);
    assert.match(pruned.parts[0].content, /history_read/);
    if (content.startsWith('{')) assert.equal(JSON.parse(pruned.parts[0].content.split('\nHistory source:')[0]).exitCode, 1);
  }
});

function evidenceFixture(t, objective = '修复登录问题并运行测试') {
  const dir = mkdtempSync(join(tmpdir(), 'bot-evidence-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = store.createSession({ title: 'Bot', mode: 'chat', agentId: 'general', metadata: { botId: 'b', canonicalBotChat: true } });
  const child = store.createSession({ title: 'Work', mode: 'subagent', agentId: 'general', parentSessionId: parent.id });
  const goal = new BotGoalService(store, Date.now, parent.id).create({ botId: 'b', sessionId: parent.id, title: objective, objective });
  const service = new BotGoalService(store, Date.now, parent.id);
  const execution = service.claim('b', goal.id, {strategy:'subagent'});
  service.updateExecution('b', execution.id, {sessionId:parent.id,runRef:`session:${child.id}`});
  store.updateSession(child.id,{metadata:{...child.metadata,botId:'b',botGoalId:goal.id,botGoalScopeSessionId:parent.id}});
  const append = (role, parts) => store.appendMessage(child.id, role, parts);
  const tool = (id, content, ok = true) => {
    append('assistant', [{ type: 'tool_call', toolCallId: id, name: 'bash', input: { command: 'pnpm test' } }]);
    append('tool', [{ type: 'tool_result', toolCallId: id, name: 'bash', ok, content }]);
  };
  return { store, child, goal, append, tool };
}

test('completion evidence keeps early results and latest test output in parseable bounded input [AC:bot-execution-p0#AC-4]', async t => {
  const f = evidenceFixture(t);
  f.tool('early', 'Observed file change: login.ts');
  for (let i = 0; i < 40; i++) f.append('assistant', [{ type: 'text', text: 'progress '.repeat(100) }]);
  f.tool('tests', 'compile '.repeat(10000) + 'FINAL: 14 tests passed');
  f.append('assistant', [{ type: 'text', text: 'Finished and checked.' }]);
  let packet;
  const report = await judgeChildCompletion({ store: f.store, judge: async input => {
    assert.ok(input.user.length <= 24000);
    packet = JSON.parse(input.user);
    assert.match(JSON.stringify(packet), /Observed file change: login.ts/);
    assert.match(JSON.stringify(packet), /FINAL: 14 tests passed/);
    assert.ok(packet.observations.every(o => o.ref && o.toolCallId && o.name));
    return JSON.stringify({ met: true, advanced: true, reason: 'Tests checked', evidenceRefs: packet.observations.map(o => o.ref), evidence: ['14 tests passed'] });
  } }, f.goal, f.child.id, 'Finished and checked.');
  assert.equal(report.verified, true);
  assert.ok(packet);
});

test('external-action completion cannot rely on prose or forged tool evidence [AC:bot-execution-p0#AC-4]', async t => {
  const f = evidenceFixture(t);
  f.append('assistant', [{ type: 'text', text: 'I fixed login and all tests passed.' }]);
  const judge = async () => JSON.stringify({ met: true, evidence: ['all tests passed'], evidenceRefs: ['invented'], reason: 'done' });
  let report = await judgeChildCompletion({ store: f.store, judge }, f.goal, f.child.id, 'I fixed login and all tests passed.');
  assert.equal(report.verified, false);
  f.tool('failed-test', 'tests failed', false);
  report = await judgeChildCompletion({ store: f.store, judge }, f.goal, f.child.id, 'done');
  assert.equal(report.verified, false);
});

test('specific gaps resume work while invalid or unavailable verdicts retain pending evidence [AC:bot-execution-p0#AC-5]', async t => {
  const f = evidenceFixture(t);
  f.tool('tests', 'login timeout still fails', false);
  const report = await judgeChildCompletion({ store: f.store, judge: async () => JSON.stringify({ met: false, advanced: true, reason: 'Login timeout fails', missing: ['Fix login timeout and rerun auth.test.ts'], evidence: [] }) }, f.goal, f.child.id, 'Partial work');
  assert.match(report.nextStep, /auth.test.ts/);
  for (const judge of [async () => { throw Error('offline'); }, async () => '{}', async () => 'null', async () => '{"met":false}']) {
    const held = await judgeChildCompletion({ store: f.store, judge }, f.goal, f.child.id, 'Partial work');
    assert.equal(held.kind, 'candidate_completed');
    assert.equal(held.verified, false);
    assert.ok(held.evidence.length);
  }
});

test('goal judges resolve the session model rather than the runtime default [AC:bot-execution-p0#AC-6]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-judge-model-'));
  const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: { name: 'global', async completeText() { return 'GLOBAL'; }, async summarizeMessages() { return ''; }, async runTurn() { return { stopReason: 'end', assistantParts: [] }; } } });
  t.after(async () => { await Promise.all(rt.store.listSessions().map(session => rt.listTraceEvents(session.id))); const ids = rt.store.listSessions().map(session => session.id); await rt.destroy(); await Promise.all(ids.map(id => rt.listTraceEvents(id))); rmSync(dir, { recursive: true, force: true }); });
  const bot = rt.createBot({ name: 'Pinned judge' });
  const sid = rt.openBot(bot.id).sessionId;
  // A configured heuristic override is deterministic and must not fall back to GLOBAL.
  rt.mergeSessionMetadata(sid, { modelOverride: { providerId: 'heuristic', modelId: 'heuristic' } });
  const host = rt.goalRuntimeHost();
  assert.equal(typeof host.judgeForSession, 'function');
  const judge = host.judgeForSession(rt.getSession(sid));
  assert.notEqual(await judge({ system: 'Evaluate', user: 'test' }), 'GLOBAL');
});

test('Bot prompt prioritizes execution and proof without forcing role pipelines [AC:bot-execution-p0#AC-7]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-prompt-'));
  const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state') });
  t.after(async () => { const ids = rt.store.listSessions().map(session => session.id); await rt.destroy(); await Promise.all(ids.map(id => rt.listTraceEvents(id))); rmSync(dir, { recursive: true, force: true }); });
  const bot = rt.createBot({ name: 'Executor' });
  const session = rt.getSession(rt.openBot(bot.id).sessionId);
  const agent = rt.store.getAgent(bot.agentId);
  const prefix = new PromptBuilder({ store: rt.store, repoRoot: dir }).buildStablePrefix({ agent, session, repoRoot: dir });
  assert.doesNotMatch(prefix, /Long-running harness: orchestrate planner/);
  assert.match(prefix, /tool call.*evidence|evidence.*tool call/i);
  assert.match(prefix, /already.authorized/i);
  assert.match(prefix, /blocker/i);
  assert.match(prefix, /permissionMode|approval/);
});

test('full Bot run keeps a question-form delivery goal and verifies real file-tool evidence [AC:bot-execution-p0#AC-1] [AC:bot-execution-p0#AC-4]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-evidence-run-'));
  let rt;
  const file = join(dir, 'login.txt');
  let calls = 0;
  rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'scripted-execution',
    async runTurn(input) {
      calls++;
      if (calls === 1) return { stopReason: 'tool', assistantParts: [{ type: 'tool_call', toolCallId: 'write', name: 'write_file', input: { path: file, content: 'login fixed' } }] };
      if (calls === 2) return { stopReason: 'tool', assistantParts: [{ type: 'tool_call', toolCallId: 'read', name: 'read_file', input: { path: file } }] };
      const result = input.messages.flatMap(m => m.parts).find(p => p.type === 'tool_result' && p.toolCallId === 'read');
      assert.match(result.content, /login fixed/);
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'login fixed; verified file' }] };
    },
    async completeText(input) {
      if (!input.system.startsWith('Evaluate')) return '{"intents":[]}';
      const packet = JSON.parse(input.user);
      const observed = packet.observations.find(o => o.name === 'read_file');
      assert.match(observed.content, /login fixed/);
      return JSON.stringify({ met: true, reason: 'File checked', evidenceRefs: [observed.ref] });
    },
    async summarizeMessages() { return ''; }
  } });
  t.after(async () => { const ids = rt.store.listSessions().map(session => session.id); await rt.destroy(); await Promise.all(ids.map(id => rt.listTraceEvents(id))); rmSync(dir, { recursive: true, force: true }); });
  rt.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const bot = rt.createBot({ name: 'Real evidence' });
  const sid = rt.openBot(bot.id).sessionId;
  rt.mergeSessionMetadata(sid, { permissionMode: 'bypass' });
  rt.sendUserMessage(sid, '帮我修复登录功能？');
  await rt.runHumanSession(sid);
  const [goal] = new BotGoalService(rt.store, Date.now, sid).list(bot.id);
  assert.equal(goal.status, 'completed');
  assert.equal(goal.strategy, 'direct');
  assert.ok(goal.evidence.some(text => text.includes('read_file') && text.includes('login fixed')));
  assert.equal(rt.store.listSessions().filter(s => s.parentSessionId === sid).length, 0);
});

test('failed and orphan results or bookkeeping alone cannot prove action completion [AC:bot-execution-p0#AC-4]', async t => {
  const f = evidenceFixture(t);
  f.append('tool', [{ type: 'tool_result', toolCallId: 'orphan', name: 'bash', ok: true, content: 'Tests passed' }]);
  f.append('assistant', [{ type: 'tool_call', toolCallId: 'todo', name: 'TodoWrite', input: { todos: [] } }]);
  f.append('tool', [{ type: 'tool_result', toolCallId: 'todo', name: 'TodoWrite', ok: true, content: 'Saved' }]);
  f.tool('test-fail', 'exit_code=1; tests failed', false);
  const report = await judgeChildCompletion({ store: f.store, judge: async input => {
    const packet = JSON.parse(input.user);
    assert.ok(!packet.observations.some(o => o.toolCallId === 'orphan'));
    return JSON.stringify({ met: true, evidenceRefs: packet.observations.map(o => o.ref), evidence: ['done'] });
  } }, f.goal, f.child.id, 'done');
  assert.equal(report.verified, false);
});

test('oversized contracts stay pending rather than validating a cut-off objective [AC:bot-execution-p0#AC-5]', async t => {
  const f = evidenceFixture(t, '修复' + 'x'.repeat(25000));
  let called = false;
  const report = await judgeChildCompletion({ store: f.store, judge: async () => { called = true; return '{"met":true}'; } }, f.goal, f.child.id, 'done');
  assert.equal(called, false);
  assert.equal(report.kind, 'candidate_completed');
  assert.equal(report.verified, false);
});

test('informational questions remain chat even if a classifier proposes action [AC:bot-execution-p0#AC-2]', async () => {
  for (const text of ['如何修复登录问题？', 'How do I fix login?', '为什么部署失败？', '部署进度如何？']) {
    const result = await classifyGoalIntents(text, [], async () => ({ intents: [{ kind: 'new_goal', text }] }));
    assert.ok(['chat', 'query'].includes(result[0].kind), text);
  }
});

test('evidence budget handles escaped large output and absent proof without corrupting JSON [AC:bot-execution-p0#AC-4]', async t => {
  const f = evidenceFixture(t);
  for (let i = 0; i < 35; i++) f.tool(`tool-${i}`, '\\"\n'.repeat(4000) + `TAIL-${i}`);
  const report = await judgeChildCompletion({ store: f.store, judge: async input => {
    assert.ok(input.user.length <= 24000);
    const packet = JSON.parse(input.user);
    assert.ok(packet.omittedObservations > 0);
    assert.match(JSON.stringify(packet.observations.at(-1)), /TAIL-34/);
    assert.equal(packet.goal, f.goal.objective);
    return JSON.stringify({ met: false, missing: ['Inspect the referenced full results'], reason: 'Incomplete evidence' });
  } }, f.goal, f.child.id, 'done');
  assert.equal(report.kind, 'progress');
  assert.match(report.nextStep, /full results/);
});

test('completion recovers compacted originals but excludes retracted tool evidence [AC:bot-execution-p0#AC-4]', async t => {
  const f = evidenceFixture(t);
  f.tool('archived', 'verified artifact on disk');
  const first = f.store.listMessages(f.child.id);
  f.store.appendReplacement(f.child.id, { startSeq: first[0].seq, endSeq: first[1].seq, role: 'system', parts: [{ type: 'text', text: 'compacted' }], key: 'compact-summary' });
  let count;
  const inspect = async () => judgeChildCompletion({ store: f.store, judge: async input => {
    const packet = JSON.parse(input.user);
    count = packet.observations.length;
    return JSON.stringify({ met: true, evidenceRefs: packet.observations.map(o => o.ref) });
  } }, f.goal, f.child.id, 'done');
  assert.equal((await inspect()).verified, true);
  assert.equal(count, 1);
  f.store.hideRange(f.child.id, first[0].seq, first[1].seq);
  assert.equal((await inspect()).verified, false);
  assert.equal(count, 0);
});
