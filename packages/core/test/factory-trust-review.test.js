import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryTools } from '../dist/factory/tools.js';
import { redactFactoryOutput } from '../dist/factory/redaction.js';

function dispatchFixture(metadata = {}, inRoom = false) {
  const principal = { userId: 'owner', tenantId: 'team' };
  const session = { id: 'coordinator-session', metadata: { ...principal, botId: 'coordinator', ...metadata, ...(inRoom ? { roomId: 'factory-room' } : {}) } };
  const messages = [{ id: 'request', role: 'user' }];
  const submitted = [];
  const store = {
    getSession: () => session,
    listMessages: () => messages,
    getDaemonControl: () => undefined,
  };
  const rooms = { turns: () => [{ currentSessionId: session.id, status: 'running', messageId: 'human-room-message' }] };
  const factory = {
    settings: () => ({ roomId: 'factory-room', coordinatorBotId: 'coordinator' }),
    submit: (p, input) => { submitted.push(input); return { id: 'factory-test' }; },
    tick: async () => {},
  };
  const tool = createFactoryTools(store, rooms, factory).find(t => t.name === 'factory_dispatch');
  return { session, messages, submitted, run: () => tool.execute({ session }, { machineId: 'worker', repositoryId: 'core', operation: 'snapshot' }) };
}

test('private Bot relays and unattended wakes cannot authorize factory dispatch [AC:multi-machine-readonly-pilot#AC-5]', async () => {
  for (const source of ['bot-message', 'delegation', 'routine', 'scheduler']) {
    const f = dispatchFixture({ approvalWake: { kind: 'unattended', source } });
    const outcome = await f.run();
    assert.equal(outcome.ok, false, source);
    assert.equal(f.submitted.length, 0, source);
  }
  assert.equal((await dispatchFixture().run()).ok, false, 'unproven raw user history');
});

test('factory dispatch checks live wake provenance and current relay anchor [AC:multi-machine-readonly-pilot#AC-5]', async () => {
  const f = dispatchFixture({ approvalWake: { kind: 'human', source: 'lab-chat' }, relayHop: 1, relayHopMessageId: 'request' });
  assert.equal((await f.run()).ok, false, 'role=user Bot relay is not human');
  f.messages.push({ id: 'actual-human', role: 'user' });
  assert.equal((await f.run()).ok, true, 'newer explicit human wake supersedes old relay');
  const stale = { ...f.session, metadata: { ...f.session.metadata } };
  f.session.metadata.approvalWake = { kind: 'unattended', source: 'routine' };
  const tool = createFactoryTools({ getSession: () => f.session, listMessages: () => f.messages, getDaemonControl: () => undefined }, {}, { settings: () => ({ coordinatorBotId: 'coordinator', roomId: 'factory-room' }), submit: () => { throw Error('must not submit'); } }).find(t => t.name === 'factory_dispatch');
  assert.equal((await tool.execute({ session: stale }, {})).ok, false);
});

test('explicit human chat and scheduled human Room requests still dispatch [AC:multi-machine-readonly-pilot#AC-3]', async () => {
  assert.equal((await dispatchFixture({ approvalWake: { kind: 'human', source: 'lab-chat' } }).run()).ok, true);
  assert.equal((await dispatchFixture({ approvalWake: { kind: 'unattended', source: 'room' } }, true).run()).ok, true);
});

test('factory log credentials redact complete headers and quoted values [AC:multi-machine-readonly-pilot#AC-2] [AC:multi-machine-readonly-pilot#AC-18]', () => {
  const samples = [
    ['Authorization: Basic dXNlcjpzZWNyZXQ=', 'dXNlcjpzZWNyZXQ='],
    ['Cookie: session=first-cookie; auth=second-cookie', 'second-cookie'],
    ['Set-Cookie: session=private-cookie; Path=/; HttpOnly', 'private-cookie'],
    ['password="my secret value"', 'secret value'],
    ["{'password': 'another secret value'}", 'another secret value'],
    ['https://private-user:private-pass@example.test/log', 'private-pass'],
  ];
  for (const [log, secret] of samples) {
    const clean = redactFactoryOutput({ log });
    assert.ok(!JSON.stringify(clean).includes(secret), log);
    assert.ok(clean.log.includes('[REDACTED'), log);
  }
});
