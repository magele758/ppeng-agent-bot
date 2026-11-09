import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { autoCompactSession } from '../dist/runtime/compact-host.js';
import { createExtensionRegistry } from '../dist/extensions/extension-registry.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'startup-summary-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({ title: 'bot', mode: 'chat', agentId: 'bot', metadata: { canonicalBotChat: true, botId: 'bot' } });
  for (let i = 0; i < 60; i++) store.appendMessage(session.id, i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `message ${i}` }]);
  const requests = [], traces = [];
  const adapter = { name: 'scripted', contextWindow: 131072, completeText(input) { return new Promise(resolve => requests.push({ input, resolve })); } };
  const host = { store, stateDir: dir, modelAdapter: adapter, extensionRegistry: createExtensionRegistry(), turnShapeBySession: new Map(), emitTrace(_id, event) { traces.push(event); }, async prepareMessagesForModel(_s, messages) { return messages; } };
  const context = { repoRoot: dir, stateDir: dir, session, agent: { id: 'bot', name: 'bot', role: 'assistant', instructions: '', capabilities: [] } };
  return { dir, store, session, host, context, requests, traces };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('slow summary is cancelled without late history replacement [AC:bot-startup-summary-latency#AC-1]', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = autoCompactSession(f.host, f.context);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].input.signal, 'summary request needs cancellation');
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, {});
  assert.equal(f.requests[0].input.signal.aborted, true);
  f.requests[0].resolve('late summary');
  await flush();
  assert.equal(f.store.foldMessages(f.session.id).length, 60);
  assert.equal(f.store.getSession(f.session.id).summary, undefined);
  assert.ok(f.traces.some(e => e.kind === 'compact_skipped' && e.payload.reason === 'summary_timeout'));
});

test('timeout cooldown is session scoped and expires [AC:bot-startup-summary-latency#AC-2]', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = autoCompactSession(f.host, f.context);
  await flush();
  t.mock.timers.tick(5000);
  await pending;
  await autoCompactSession(f.host, f.context);
  assert.equal(f.requests.length, 1);
  const otherSession = f.store.createSession({ title: 'other', mode: 'chat', agentId: 'bot', metadata: { canonicalBotChat: true, botId: 'bot' } });
  for (let i = 0; i < 60; i++) f.store.appendMessage(otherSession.id, 'user', [{ type: 'text', text: 'other' }]);
  const otherPending = autoCompactSession(f.host, { ...f.context, session: otherSession });
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve('other summary');
  await otherPending;
  t.mock.timers.tick(30000);
  const retry = autoCompactSession(f.host, f.context);
  await flush();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve('recovered');
  assert.ok((await retry).replaced);
});

test('forced compact bypasses cooldown and successful summary archives history [AC:bot-startup-summary-latency#AC-3]', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = autoCompactSession(f.host, f.context);
  await flush();
  t.mock.timers.tick(5000);
  await pending;
  const forced = autoCompactSession(f.host, f.context, { force: true });
  await flush();
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].input.signal);
  f.requests[1].resolve('Goal: continue work');
  assert.ok((await forced).replaced);
  assert.match(f.store.getSession(f.session.id).summary, /continue work/);
  assert.equal(readdirSync(join(f.dir, 'transcripts', f.session.id)).length, 1);
});

 test('legacy summarizer that ignores cancellation cannot write a late replacement [AC:bot-startup-summary-latency#AC-1]', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let finish;
  f.host.modelAdapter = { name: 'legacy', summarizeMessages() { return new Promise(resolve => { finish = resolve; }); } };
  const pending = autoCompactSession(f.host, f.context, { force: true });
  await flush();
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, {});
  finish('late legacy summary');
  await flush();
  assert.equal(f.store.foldMessages(f.session.id).length, 60);
 });

 test('forced summary still times out during cooldown [AC:bot-startup-summary-latency#AC-3]', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const options of [undefined, { force: true }]) {
    const pending = autoCompactSession(f.host, f.context, options);
    await flush();
    t.mock.timers.tick(5000);
    assert.deepEqual(await pending, {});
  }
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.input.signal.aborted));
 });

test('explicit Bot compaction accepts a six-second summary by default [AC:bot-session-decisions#AC-2]', async t => {
  const { RawAgentRuntime } = await import('../dist/runtime.js');
  const dir = mkdtempSync(join(tmpdir(), 'bot-long-summary-'));
  let request, finish;
  const runtime = new RawAgentRuntime({repoRoot:dir, stateDir:dir, modelAdapter:{
    name:'slow-summary', completeText(input){request=input; return new Promise(resolve=>{finish=resolve;});}
  }});
  t.after(async () => { await runtime.destroy(); rmSync(dir,{recursive:true,force:true}); });
  const bot = runtime.createBot({name:'summary-test'});
  const {sessionId} = runtime.openBot(bot.id);
  for(let i=0;i<60;i++) runtime.store.appendMessage(sessionId,i%2?'assistant':'user',[{type:'text',text:'step '+i}]);
  t.mock.timers.enable({apis:['setTimeout']});
  const pending = runtime.compactCanonicalSession(sessionId);
  await flush();
  t.mock.timers.tick(6000);
  assert.equal(request.signal.aborted,false);
  finish('current decision');
  assert.ok((await pending).replaced);
  assert.equal(readdirSync(join(dir,'transcripts',sessionId)).length,1);
});
