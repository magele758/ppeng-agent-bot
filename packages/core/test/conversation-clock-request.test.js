import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { zonedClock } from '../src/session/conversation-clock.ts';

test('product model request uses the session calendar day and does not store the live clock [AC:conversation-date-clock#AC-1] [AC:conversation-date-clock#AC-2] [AC:conversation-date-clock#AC-5] [AC:conversation-date-clock#AC-6]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-clock-'));
  let delivered;
  const rt = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'scripted',
      async runTurn(input) {
        delivered = input;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  try {
    const session = rt.store.createSession({
      title: 'clock',
      mode: 'chat',
      agentId: 'general',
      background: false,
      metadata: { timezone: 'Asia/Shanghai' }
    });
    const boundary = zonedClock(Date.parse('2026-10-26T16:30:00.000Z'), 'Asia/Shanghai');
    assert.equal(boundary.date, '2026-10-27');
    assert.notEqual(boundary.date, '2026-10-26');
    const today = zonedClock(Date.now(), 'Asia/Shanghai').date;
    const insert = rt.store.db.prepare(
      'INSERT INTO session_messages(id, session_id, role, parts_json, created_at, seq, surface_op) VALUES(?,?,?,?,?,?,?)'
    );
    insert.run(
      'old-user',
      session.id,
      'user',
      JSON.stringify([{ type: 'text', text: '今天' }]),
      '2026-10-20T02:00:00.000Z',
      1,
      'append'
    );
    insert.run(
      'old-assistant',
      session.id,
      'assistant',
      JSON.stringify([{ type: 'text', text: '今天' }]),
      '2026-10-20T03:00:00.000Z',
      2,
      'append'
    );
    rt.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'continue' }]);
    const agent = { id: 'general', name: 'general', role: 'general', instructions: '', capabilities: [] };
    const stable = rt.promptBuilder.buildStablePrefix({ agent, session, task: undefined });
    assert.equal(stable.includes('Current calendar date'), false);
    await rt.runSession(session.id);
    assert.ok(delivered, 'model request was not delivered');
    assert.equal(delivered.systemPrompt.includes('Current calendar date'), false);
    assert.equal(delivered.systemPrompt.includes('Current time:'), false);
    assert.equal(delivered.systemPrompt.includes('[conversation-clock]'), false);
    const text = JSON.stringify(delivered.messages);
    assert.match(text, /\[written 2026-10-20/);
    assert.match(text, /今天/);
    assert.match(text, /\[conversation-clock\]/);
    assert.match(text, new RegExp(`Current time: ${today}`));
    assert.match(text, /Asia\/Shanghai/);
    assert.notEqual(today, '2026-10-20');
    const stored = JSON.stringify(rt.store.foldMessages(session.id));
    assert.equal(stored.includes('[conversation-clock]'), false);
    assert.equal(stored.includes('Current time:'), false);
  } finally {
    rt.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('external reads preserve the request prefix, recovery and compacted windows [AC:request-context-events#AC-1] [AC:request-context-events#AC-2] [AC:request-context-events#AC-3]', async t => {
  const { prepareRequestContext } = await import('../dist/session/request-context-events.js');
  const { SqliteStateStore } = await import('../dist/storage.js');
  const { SourceLedger } = await import('../dist/learning/sources.js');
  const dir = mkdtempSync(join(tmpdir(), 'context-events-'));
  const path = join(dir, 'test.db');
  let store = new SqliteStateStore(path);
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({ title: 'old session', agentId: 'general', mode: 'chat' });
  const sid = session.id;
  const user = store.appendMessage(sid, 'user', [{ type: 'text', text: 'Inspect only' }]);
  const ledger = () => new SourceLedger(store);
  ledger().record(sid, { kind: 'event', ref: 'old-source', label: 'old source' });
  const prepare = (history, time) => prepareRequestContext(store, sid, history, Date.parse(time), 'UTC');
  const before = prepare([user], '2026-11-13T23:55Z');
  assert.match(JSON.stringify(before), /old-source/);
  const call = store.appendMessage(sid, 'assistant', [{ type: 'tool_call', toolCallId: 'one', name: 'read_file', input: {} }]);
  const result = store.appendMessage(sid, 'tool', [{ type: 'tool_result', toolCallId: 'one', name: 'read_file', content: '«external source=file» evidence', ok: true }]);
  ledger().record(sid, { kind: 'tool', ref: 'new-tool-source', label: 'file' });
  const history = [user, call, result];
  const after = prepare(history, '2026-11-13T23:56Z');
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length), [call, result]);
  ledger().configure(sid, { allowedEffects: ['network'] });
  const wake = prepare(history, '2026-11-14T01:00Z');
  assert.deepEqual(wake.slice(0, after.length), after);
  assert.match(JSON.stringify(wake.slice(after.length)), /2026-11-14/);
  assert.match(JSON.stringify(wake.slice(after.length)), /network/);
  store.db.close(); store = new SqliteStateStore(path);
  assert.deepEqual(prepare(history, '2026-11-14T01:01Z'), wake);
  ledger().configure(sid, { allowedEffects: [] });
  assert.equal(ledger().allowed(sid, 'network', 'external'), false);
  const summary = { ...user, id: 'fold', role: 'system', key: 'compact-summary', parts: [{ type: 'text', text: 'summary' }] };
  const compacted = prepare([summary, call, result], '2026-11-14T02:00Z');
  assert.match(JSON.stringify(compacted), /new-tool-source/);
  assert.deepEqual(compacted.filter(m => ['assistant','tool'].includes(m.role)), [call, result]);
  assert.ok(!JSON.stringify(store.foldMessages(sid)).includes('[conversation-clock]'));
});

test('wire diagnostics distinguish append-only history, rewrites and tool changes without storing content', async () => {
  const { recordWireShape } = await import('../dist/session/request-wire-diagnostics.js');
  let saved;
  const store = { getDaemonControl: () => saved, setDaemonControl: (_key, value) => { saved = value; } };
  const check = (input, expected, tools = []) => {
    recordWireShape(store, 'test', { model: 'same', tools, input });
    assert.equal(saved.firstDifference, expected);
    assert.ok(!JSON.stringify(saved).includes('private-content'));
  };
  check(['private-content'], 'first-request');
  check(['private-content', 'result'], 'append-only');
  check(['private-content', 'result'], 'unchanged');
  check(['changed', 'result'], 'input[0]');
  check(['changed'], 'shortened');
  check(['changed'], 'request-settings', ['new-tool']);
});

test('both product kernels deliver the host phase at the end of a Responses request [AC:responses-session-phase-cache#AC-1]', async t => {
  const { OpenAICompatibleAdapter } = await import('../dist/model/model-adapters.js');
  const dir = mkdtempSync(join(tmpdir(), 'responses-phase-'));
  const delivered = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    delivered.push(body);
    const response = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
    return body.stream
      ? new Response('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\ndata: [DONE]\n\n')
      : Response.json(response);
  });
  const adapter = new OpenAICompatibleAdapter({ apiKey: 'test', baseUrl: 'https://example.invalid/v1', model: 'test', httpKind: 'responses', useJsonMode: false });
  const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter });
  t.after(async () => { await rt.destroy(); rmSync(dir, { recursive: true, force: true }); });
  for (const kernelVariant of ['agent-loop', 'ppeng']) {
    rt.store.setDaemonControl('loop_settings', { kernelVariant });
    const session = rt.store.createSession({ title: 'phase', agentId: 'general', mode: 'chat', background: false });
    rt.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'Inspect current status' }]);
    rt.promptBuilder.lastCognitivePhaseBySession.set(session.id, { phase: 'debugging', confidence: 0.69 });
    delivered.length = 0;
    await rt.runSession(session.id);
    await rt.listTraceEvents(session.id, 1);
    const wire = delivered.find(body => body.tools);
    assert.ok(wire, kernelVariant);
    assert.doesNotMatch(wire.instructions, /Session phase:/);
    assert.equal(wire.input.at(-1).role, 'developer', kernelVariant);
    assert.match(wire.input.at(-1).content[0].text, /^Session phase: /);
    assert.doesNotMatch(JSON.stringify(rt.store.foldMessages(session.id)), /Session phase:/);
  }
});
