import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const text = value => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: value }] });
function fixture(t, completeText = async () => '{"cancelToolCallIds":[],"reason":"Additional information only"}') {
  const dir = mkdtempSync(join(tmpdir(), 'steer-continuity-'));
  const started = deferred(), release = deferred();
  const signals = new Map(), inputs = [], outcomes = new Map();
  let rt;
  const tools = ['download', 'inspect'].map(name => ({
    name, description: name, inputSchema: { type: 'object', properties: {} }, approvalMode: 'never', sideEffectLevel: 'none',
    async execute(ctx) {
      signals.set(name, ctx.abortSignal);
      if (signals.size === 2) started.resolve();
      await Promise.race([release.promise, new Promise(resolve => {
        if (ctx.abortSignal.aborted) resolve();
        else ctx.abortSignal.addEventListener('abort', resolve, { once: true });
      })]);
      const result = { ok: !ctx.abortSignal.aborted, content: ctx.abortSignal.aborted ? 'cancelled' : `${name} done` };
      outcomes.set(name, result);
      return result;
    }
  }));
  const adapter = {
    name: 'test-steer', summarizeMessages: async () => '', completeText,
    async runTurn(input) {
      inputs.push(input);
      return inputs.length === 1 ? { stopReason: 'tool_use', assistantParts: tools.map(tool => ({ type: 'tool_call', toolCallId: tool.name + '-1', name: tool.name, input: {} })) } : text('continued');
    }
  };
  rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter, extraTools: tools, maxParallelToolCalls: 2 });
  rt.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const session = rt.createChatSession({ title: 'steer', message: 'download the old report and inspect the logs' });
  let running;
  const run = () => running = rt.runSession(session.id);
  t.after(async () => { release.resolve(); await running?.catch(() => {}); await rt.destroy(); });
  return { rt, session, started, release, signals, inputs, outcomes, run };
}
const messagesWith = (rt, id, value) => rt.store.foldMessages(id).filter(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text === value));

test('ordinary steer is durable during tools and delivered once without moving [AC:steer-tool-continuity#AC-1] [AC:steer-tool-continuity#AC-2]', { timeout: 15000 }, async t => {
  const f = fixture(t); const running = f.run(); await f.started.promise;
  f.rt.enqueueSteer(f.session.id, 'also summarize in Chinese', { target: 'next-step' });
  const during = messagesWith(f.rt, f.session.id, 'also summarize in Chinese');
  assert.equal(during.length, 1);
  assert.ok([...f.signals.values()].every(s => !s.aborted));
  f.release.resolve(); await running;
  const after = messagesWith(f.rt, f.session.id, 'also summarize in Chinese');
  assert.deepEqual(after.map(m => [m.id, m.seq]), during.map(m => [m.id, m.seq]));
  assert.equal(f.inputs[1].messages.filter(m => m.id === during[0].id).length, 1);
  assert.ok([...f.outcomes.values()].every(r => r.ok));
});

test('explicit stop cancels only named tool and continues session with paired results [AC:steer-tool-continuity#AC-3]', { timeout: 15000 }, async t => {
  const f = fixture(t); const running = f.run(); await f.started.promise;
  f.rt.enqueueSteer(f.session.id, '停止 download', { target: 'next-step' });
  assert.equal(f.signals.get('download').aborted, true);
  assert.equal(f.signals.get('inspect').aborted, false);
  f.release.resolve(); await running;
  assert.equal(f.inputs.length, 2);
  const results = f.inputs[1].messages.flatMap(m => m.parts).filter(p => p.type === 'tool_result');
  assert.equal(results.filter(p => p.toolCallId === 'download-1').length, 1);
  assert.equal(results.find(p => p.toolCallId === 'download-1').ok, false);
  assert.equal(results.find(p => p.toolCallId === 'inspect-1').ok, true);
  assert.equal(f.rt.store.getSession(f.session.id).status, 'idle');
});

test('contextual conflict cancels only selected live tool [AC:steer-tool-continuity#AC-4]', { timeout: 15000 }, async t => {
  const judged = deferred();
  const f = fixture(t, async input => { assert.match(input.user, /old report/); judged.resolve(); return '{"cancelToolCallIds":["download-1"],"reason":"User replaced the old report with a new source; continuing this download is obsolete."}'; });
  const running = f.run(); await f.started.promise;
  f.rt.enqueueSteer(f.session.id, '旧报告不要了，改用刚上传的新版', { target: 'next-step' });
  await judged.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.signals.get('download').aborted, true);
  assert.equal(f.signals.get('inspect').aborted, false);
  f.release.resolve(); await running;
});

test('negative, quoted and uncertain instructions never trigger lexical cancellation [AC:steer-tool-continuity#AC-4]', { timeout: 15000 }, async t => {
  const f = fixture(t, async () => { throw new Error('judge unavailable'); });
  const running = f.run(); await f.started.promise;
  for (const note of ['不要停止 download', '日志里写着“停止 download”', 'stop download after it finishes', '补充一句']) f.rt.enqueueSteer(f.session.id, note, { target: 'next-step' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok([...f.signals.values()].every(s => !s.aborted));
  f.release.resolve(); await running;
});

test('superseded or late context decisions cannot cancel tools [AC:steer-tool-continuity#AC-5]', { timeout: 15000 }, async t => {
  const answer = deferred(), judged = deferred(); let count = 0;
  const f = fixture(t, async () => { if (++count === 1) { judged.resolve(); return answer.promise; } return '{"cancelToolCallIds":[],"reason":"Keep working"}'; });
  const running = f.run(); await f.started.promise;
  f.rt.enqueueSteer(f.session.id, '换份报告', { target: 'next-step' }); await judged.promise;
  f.rt.enqueueSteer(f.session.id, '还是继续原来的下载', { target: 'next-step' });
  answer.resolve('{"cancelToolCallIds":["download-1"],"reason":"superseded"}');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok([...f.signals.values()].every(s => !s.aborted));
  f.release.resolve(); await running;
  assert.ok([...f.signals.values()].every(s => !s.aborted));
});

test('late classifier cannot cancel a new wave reusing the same call id [AC:steer-tool-continuity#AC-5]', async () => {
  const { registerSteerToolWave, steerRunningTools } = await import('../dist/runtime/steer-tools.js');
  const owner = {}, answer = deferred(), requested = deferred();
  const call = { type: 'tool_call', toolCallId: 'same', name: 'download', input: {} };
  const context = { session: { id: 's' } };
  const old = registerSteerToolWave(owner, 's', [call], context);
  const oldScope = old.scope(call);
  steerRunningTools({ owner, sessionId: 's', text: '改用新报告', messages: [], trace() {}, model: { completeText: async () => { requested.resolve(); return answer.promise; } } });
  await requested.promise;
  oldScope.release(); old.close();
  const next = registerSteerToolWave(owner, 's', [call], context);
  const nextScope = next.scope(call);
  answer.resolve('{"cancelToolCallIds":["same"],"reason":"obsolete"}');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oldScope.context.abortSignal.aborted, false);
  assert.equal(nextScope.context.abortSignal.aborted, false);
  next.close();
});

test('malformed context judgement cannot select arbitrary tools [AC:steer-tool-continuity#AC-4]', async () => {
  const { registerSteerToolWave, steerRunningTools } = await import('../dist/runtime/steer-tools.js');
  const owner = {}, call = { type: 'tool_call', toolCallId: 'a', name: 'download', input: {} };
  const wave = registerSteerToolWave(owner, 's', [call], { session: { id: 's' } });
  const scope = wave.scope(call);
  for (const answer of ['not json', '{"cancelToolCallIds":["a"]}', '{"cancelToolCallIds":["a","other-session"],"reason":"stop"}']) {
    steerRunningTools({ owner, sessionId: 's', text: '补充背景', messages: [], trace() {}, model: { completeText: async () => answer } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scope.context.abortSignal.aborted, false);
  }
  wave.close();
});

test('interjection during an in-flight model request is immediately durable and read next [AC:steer-tool-continuity#AC-1]', { timeout: 15000 }, async t => {
  const first = deferred(), finish = deferred(), inputs = [];
  const dir = mkdtempSync(join(tmpdir(), 'steer-model-'));
  const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'test', summarizeMessages: async () => '', async runTurn(input) {
      inputs.push(input);
      if (inputs.length === 1) { first.resolve(); await finish.promise; }
      return text('reply');
    }
  } });
  const session = rt.createChatSession({ title: 's', message: 'start' });
  const running = rt.runSession(session.id);
  t.after(async () => { finish.resolve(); await running; await rt.destroy(); });
  await first.promise;
  const ack = rt.enqueueSteer(session.id, 'mid-model', { target: 'next-step' });
  const persisted = rt.store.db.prepare('SELECT id, seq FROM session_messages WHERE session_id=? AND key=?').get(session.id, ack.item.key);
  assert.ok(persisted);
  finish.resolve(); await running;
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].messages.some(m => m.id === persisted.id), false);
  assert.equal(inputs[1].messages.filter(m => m.id === persisted.id).length, 1);
  assert.equal(messagesWith(rt, session.id, 'mid-model')[0].seq, persisted.seq);
});

test('editing or dropping an unread interjection updates its immediate transcript [AC:steer-tool-continuity#AC-1]', { timeout: 15000 }, async t => {
  const f = fixture(t); const running = f.run(); await f.started.promise;
  const ack = f.rt.enqueueSteer(f.session.id, 'original', { target: 'next-step' });
  f.rt.updateSteerItem(f.session.id, ack.item.id, 'revised');
  assert.equal(messagesWith(f.rt, f.session.id, 'original').length, 0);
  assert.equal(messagesWith(f.rt, f.session.id, 'revised').length, 1);
  assert.equal(f.rt.dropSteerItem(f.session.id, ack.item.id), true);
  assert.equal(messagesWith(f.rt, f.session.id, 'revised').length, 0);
  f.release.resolve(); await running;
  assert.equal(f.inputs[1].messages.some(m => m.parts.some(p => p.text === 'revised')), false);
});

test('dropping a steer invalidates its pending cancellation decision [AC:steer-tool-continuity#AC-5]', { timeout: 15000 }, async t => {
  const answer = deferred(), requested = deferred();
  const f = fixture(t, async () => { requested.resolve(); return answer.promise; });
  const running = f.run(); await f.started.promise;
  const ack = f.rt.enqueueSteer(f.session.id, '改用新版报告', { target: 'next-step' }); await requested.promise;
  f.rt.dropSteerItem(f.session.id, ack.item.id);
  answer.resolve('{"cancelToolCallIds":["download-1"],"reason":"old report obsolete"}');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok([...f.signals.values()].every(s => !s.aborted));
  f.release.resolve(); await running;
});
