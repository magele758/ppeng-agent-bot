import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { waitFor } from './helpers/settle.js';
import { createBot, updateBot } from '../dist/bots/index.js';
import { authorizeToolsForSession, filterToolsForSession, resolveTurnTools } from '../dist/turn/resolve-turn-tools.js';
import {
  createMessageAgentTool,
  effectiveRelayHop,
  formatBotMessage,
  isCanonicalBotChatSession,
  MESSAGE_AGENT_TOOL_NAME,
  isSilenceToken,
  MESSAGE_MAX_CHARS,
  readRelayHop,
  wantsWake
} from '../dist/tools/message-agent.js';
import { startIdleSessionRun } from '../dist/runtime/scheduler-host.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'message-agent-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  return { dir, store };
}

test('room retrieval extends session allowlists while agent restrictions remain authoritative [AC:bot-room-recall#AC-2] [AC:bot-room-recall#AC-3]', () => {
  const retrieval = ['room_history_search', 'room_history_read', 'room_material_list', 'room_material_read'];
  const tools = ['read_file', 'bash', ...retrieval].map(name => ({ name, description: name, inputSchema: {}, approvalMode: 'never', sideEffectLevel: 'none', execute: async () => ({ ok: true, content: '' }) }));
  const agent = { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] };
  const session = { id: 'room-member', mode: 'chat', agentId: agent.id, metadata: { roomId: 'room', allowedTools: ['read_file'] } };
  const names = (selectedAgent, selectedSession) => authorizeToolsForSession({ env: {}, tools, agent: selectedAgent, session: selectedSession }).tools.map(tool => tool.name);
  assert.deepEqual(names(agent, session), ['read_file', ...retrieval]);
  assert.deepEqual(names(agent, { ...session, metadata: { allowedTools: ['read_file'] } }), ['read_file']);
  assert.deepEqual(names({ ...agent, allowedTools: ['read_file', 'room_history_read'] }, session), ['read_file', 'room_history_read']);
  assert.deepEqual(session.metadata.allowedTools, ['read_file']);
});

function facadeHost(store) {
  return {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions: () => {},
    wakeAgentSessions: () => {}
  };
}

function agentOf(bot) {
  return {
    id: bot.id,
    name: bot.name,
    role: 'Bot',
    instructions: '',
    capabilities: ['bot']
  };
}

function ctx(dir, session, bot) {
  return {
    repoRoot: dir,
    stateDir: dir,
    session,
    agent: agentOf(bot)
  };
}

function userText(store, sessionId) {
  return store
    .listMessages(sessionId)
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    );
}

function harness(store) {
  const runs = [];
  const active = new Set();
  const tool = createMessageAgentTool({
    store,
    runSession: async (sessionId) => {
      runs.push(sessionId);
      return store.getSession(sessionId);
    },
    isSessionRunning: (sessionId) => active.has(sessionId),
    log: { debug() {}, info() {}, warn() {}, error() {} }
  });
  return { tool, runs, active };
}

function asRelayed(store, sessionId, hop) {
  const msg = store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'relayed' }]);
  const s = store.getSession(sessionId);
  store.updateSession(sessionId, {
    metadata: { ...s.metadata, relayHop: hop, relayHopMessageId: msg.id }
  });
}

function call(tool, dir, store, bot, args) {
  return tool.execute(ctx(dir, store.getSession(bot.canonicalSessionId), bot), args);
}

async function failure(promise) {
  const result = await promise;
  assert.equal(result.ok, false);
  const payload = JSON.parse(result.content);
  assert.equal(payload.ok, false);
  return payload;
}

test('non-bot and subagent sessions do not see message_agent', () => {
  const { store } = tempStore();
  const bot = createBot(facadeHost(store), { name: 'Alpha' });
  const canonical = store.getSession(bot.canonicalSessionId);
  const plain = store.createSession({
    title: 'Chat',
    mode: 'chat',
    agentId: 'general',
    metadata: {}
  });
  const sub = store.createSession({
    title: 'Sub',
    mode: 'subagent',
    agentId: bot.id,
    metadata: { canonicalBotChat: true, botId: bot.id }
  });
  const stub = {
    name: 'read_file',
    description: 'r',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: '' })
  };
  const messageTool = {
    name: MESSAGE_AGENT_TOOL_NAME,
    description: 'm',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: '' })
  };
  const tools = [stub, messageTool];
  const env = {};
  const agent = agentOf(bot);

  const plainFiltered = filterToolsForSession({ env, tools, agent, session: plain });
  assert.deepEqual(
    plainFiltered.tools.map((tool) => tool.name),
    ['read_file']
  );

  const subFiltered = filterToolsForSession({ env, tools, agent, session: sub });
  assert.ok(!subFiltered.tools.some((tool) => tool.name === MESSAGE_AGENT_TOOL_NAME));

  const botFiltered = filterToolsForSession({ env, tools, agent, session: canonical });
  assert.ok(botFiltered.tools.some((tool) => tool.name === MESSAGE_AGENT_TOOL_NAME));

  const resolved = resolveTurnTools({
    env,
    tools,
    agent,
    session: plain,
    sessionId: plain.id,
    systemPromptChars: 10,
    dynTools: [messageTool]
  });
  assert.ok(!resolved.turnTools.some((tool) => tool.name === MESSAGE_AGENT_TOOL_NAME));
  store.db.close();
});

test('canonical bot delivers to a roster peer and starts a run [AC:bots#AC-2]', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  const sender = store.getSession(alpha.canonicalSessionId);
  const result = await tool.execute(ctx(dir, sender, alpha), {
    target: 'Beta',
    message: 'please review the diff'
  });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.delivered, true);
  assert.equal(payload.sessionId, beta.canonicalSessionId);
  assert.equal(payload.relayHop, 1);
  assert.equal(payload.startedRun, true);
  assert.deepEqual(userText(store, beta.canonicalSessionId), [
    formatBotMessage(alpha, 'please review the diff')
  ]);
  assert.equal(store.getSession(beta.canonicalSessionId).metadata.relayHop, 1);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  assert.equal(userText(store, alpha.canonicalSessionId).length, 0);
  store.db.close();
});

test('message_agent can target a roster id and a same-user canonical session', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const sender = store.getSession(alpha.canonicalSessionId);
  store.updateSession(sender.id, {
    metadata: { ...sender.metadata, userId: 'user_a' }
  });
  const perUser = store.createSession({
    title: 'Bot Chat · Beta',
    mode: 'chat',
    agentId: beta.id,
    metadata: { botId: beta.id, canonicalBotChat: true, userId: 'user_a' }
  });
  const { tool, runs } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(sender.id), alpha), {
    target: beta.id,
    message: 'check the quota'
  });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.sessionId, perUser.id);
  assert.deepEqual(userText(store, perUser.id), [formatBotMessage(alpha, 'check the quota')]);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, [perUser.id]);
  store.db.close();
});

test('sending to yourself fails and writes nothing [AC:bots#AC-2]', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  const sender = store.getSession(alpha.canonicalSessionId);
  const result = await tool.execute(ctx(dir, sender, alpha), {
    target: 'Alpha',
    message: 'hello me'
  });
  assert.equal(result.ok, false);
  const payload = JSON.parse(result.content);
  assert.equal(payload.error_code, 'SELF_TARGET');
  assert.ok(payload.roster.includes('Beta'));
  assert.equal(userText(store, alpha.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('relayHop >= 3 is rejected before write', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const sender = store.getSession(alpha.canonicalSessionId);
  asRelayed(store, sender.id, 3);
  const { tool, runs } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(sender.id), alpha), {
    target: beta.id,
    message: 'keep going'
  });
  assert.equal(result.ok, false);
  const payload = JSON.parse(result.content);
  assert.equal(payload.error_code, 'HOP_LIMIT');
  assert.equal(payload.relayHop, 3);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.equal(store.getSession(beta.canonicalSessionId).metadata.relayHop, undefined);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('running target durably accepts without parallel run [AC:bot-reliable-messaging#AC-1]', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(beta.canonicalSessionId, { status: 'running' });
  const { tool, runs } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(alpha.canonicalSessionId), alpha), {
    target: 'beta',
    message: 'ping'
  });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.accepted, true);
  assert.equal(payload.queued, true);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.equal(store.getSession(beta.canonicalSessionId).status, 'running');
  assert.deepEqual(runs, []);
  store.db.close();
});

test('calling message_agent outside a canonical bot chat is rejected', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const plain = store.createSession({
    title: 'Chat',
    mode: 'chat',
    agentId: alpha.id,
    metadata: { botId: alpha.id }
  });
  const { tool, runs } = harness(store);
  const result = await tool.execute(ctx(dir, plain, alpha), {
    target: 'Beta',
    message: 'should not land'
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.content).error_code, 'NOT_CANONICAL');
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('unknown target returns a short roster and did_you_mean', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  createBot(host, { name: 'Researcher' });
  const { tool } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(alpha.canonicalSessionId), alpha), {
    target: 'Reseacher',
    message: 'hi'
  });
  const payload = JSON.parse(result.content);
  assert.equal(payload.error_code, 'UNKNOWN_TARGET');
  assert.equal(payload.did_you_mean, 'Researcher');
  assert.ok(payload.roster.includes('Researcher'));
  assert.ok(payload.roster.length <= 8);
  assert.ok(!payload.roster.includes('Alpha'));
  store.db.close();
});

test('silence tokens are stored without starting a run', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  const silent = await call(tool, dir, store, alpha, { target: 'Beta', message: '[SILENT]' });
  const payload = JSON.parse(silent.content);
  assert.equal(payload.startedRun, false);
  assert.equal(payload.woke, false);
  assert.equal(payload.skippedRun, 'silent');
  assert.deepEqual(userText(store, beta.canonicalSessionId), [formatBotMessage(alpha, '[SILENT]')]);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('background idle target is started by reliable work runner', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(beta.canonicalSessionId, { background: true });
  const { tool, runs } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(alpha.canonicalSessionId), alpha), {
    target: 'Beta',
    message: 'nightly digest'
  });
  assert.equal(JSON.parse(result.content).startedRun, true);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  assert.deepEqual(store.dequeueSchedulerWakes(), []);
  store.db.close();
});

test('overlong messages are rejected', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool } = harness(store);
  const result = await tool.execute(ctx(dir, store.getSession(alpha.canonicalSessionId), alpha), {
    target: 'Beta',
    message: 'x'.repeat(MESSAGE_MAX_CHARS + 1)
  });
  assert.equal(JSON.parse(result.content).error_code, 'MESSAGE_TOO_LONG');
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  store.db.close();
});

test('hop resets once any later user message lands (no permanent lockout)', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  asRelayed(store, alpha.canonicalSessionId, 3);
  assert.equal(effectiveRelayHop(store, store.getSession(alpha.canonicalSessionId)), 3);
  const { tool, runs } = harness(store);
  const blocked = await call(tool, dir, store, alpha, { target: 'Beta', message: 'x' });
  assert.equal(JSON.parse(blocked.content).error_code, 'HOP_LIMIT');

  store.appendMessage(alpha.canonicalSessionId, 'user', [{ type: 'text', text: 'human says hi' }]);
  assert.equal(effectiveRelayHop(store, store.getSession(alpha.canonicalSessionId)), 0);
  const ok = await call(tool, dir, store, alpha, { target: 'Beta', message: 'fresh chain' });
  assert.equal(JSON.parse(ok.content).relayHop, 1);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  store.db.close();
});

test('a stale hop on the target never blocks inbound delivery and is overwritten', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  asRelayed(store, beta.canonicalSessionId, 3);
  const { tool } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'hello' });
  assert.equal(result.ok, true);
  const meta = store.getSession(beta.canonicalSessionId).metadata;
  assert.equal(meta.relayHop, 1);
  assert.equal(effectiveRelayHop(store, store.getSession(beta.canonicalSessionId)), 1);
  store.db.close();
});

test('hop accumulates across a relay chain and stops at the limit', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const bots = ['A', 'B', 'C', 'D', 'E'].map((name) => createBot(host, { name }));
  const { tool, runs } = harness(store);
  const hops = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await call(tool, dir, store, bots[i], { target: bots[i + 1].name, message: `step ${i}` });
    assert.equal(r.ok, true);
    hops.push(JSON.parse(r.content).relayHop);
  }
  assert.deepEqual(hops, [1, 2, 3]);
  const last = await call(tool, dir, store, bots[3], { target: 'E', message: 'one too many' });
  assert.equal(JSON.parse(last.content).error_code, 'HOP_LIMIT');
  assert.equal(userText(store, bots[4].canonicalSessionId).length, 0);
  assert.equal(runs.length, 3);
  store.db.close();
});

test('isSilenceToken only matches whole-body silence tokens; FYI wording is not special', () => {
  assert.equal(isSilenceToken('  no reply '), true);
  assert.equal(isSilenceToken('[SILENT]'), true);
  assert.equal(isSilenceToken('NO_REPLY'), true);
  assert.equal(isSilenceToken('Please deploy the fix.'), false);
  assert.equal(isSilenceToken('FYI the deploy finished'), false);
  assert.equal(isSilenceToken('SILENT deploy needed'), false);
});

test('wake defaults to true: plain delegation wakes the target and the result says so', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, {
    target: 'Beta',
    message: 'Please rebuild the index tonight.'
  });
  const payload = JSON.parse(result.content);
  assert.equal(payload.woke, true);
  assert.equal(payload.startedRun, true);
  assert.equal(payload.skippedRun, undefined);
  assert.match(payload.note, /woke it/);
  assert.match(payload.note, /NOT returned/);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  store.db.close();
});

test('FYI-prefixed message that carries a task still wakes by default (no text heuristic)', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  for (const message of ['FYI the deploy finished', '[FYI] also please roll back the canary now.']) {
    const result = await call(tool, dir, store, alpha, { target: 'Beta', message });
    const payload = JSON.parse(result.content);
    assert.equal(payload.woke, true, message);
    assert.equal(payload.skippedRun, undefined);
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.deepEqual(runs, [beta.canonicalSessionId, beta.canonicalSessionId]);
  store.db.close();
});

test('wake:false stores the message without waking, whatever the wording', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, {
    target: 'Beta',
    message: 'Index rebuilt; nothing to do.',
    wake: false
  });
  const payload = JSON.parse(result.content);
  assert.equal(result.ok, true);
  assert.equal(payload.delivered, true);
  assert.equal(payload.woke, false);
  assert.equal(payload.startedRun, false);
  assert.equal(payload.skippedRun, 'wake_false');
  assert.match(payload.note, /did NOT wake/);
  assert.deepEqual(runs, []);
  assert.deepEqual(userText(store, beta.canonicalSessionId), [
    formatBotMessage(alpha, 'Index rebuilt; nothing to do.')
  ]);
  assert.equal(store.getSession(beta.canonicalSessionId).status, 'idle');

  const explicitTrue = await call(tool, dir, store, alpha, { target: 'Beta', message: 'go', wake: true });
  assert.equal(JSON.parse(explicitTrue.content).woke, true);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  store.db.close();
});

test('wake:false does not touch a failed target status', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(beta.canonicalSessionId, { status: 'failed' });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'note', wake: false });
  const payload = JSON.parse(result.content);
  assert.equal(payload.delivered, true);
  assert.equal(payload.woke, false);
  assert.equal(payload.revivedFrom, undefined);
  assert.equal(store.getSession(beta.canonicalSessionId).status, 'failed');
  assert.deepEqual(runs, []);
  store.db.close();
});

for (const status of ['failed', 'completed']) {
  test(`target in ${status} is delivered to, restarted and woken`, async () => {
    const { dir, store } = tempStore();
    const host = facadeHost(store);
    const alpha = createBot(host, { name: 'Alpha' });
    const beta = createBot(host, { name: 'Beta' });
    store.updateSession(beta.canonicalSessionId, { status });
    const { tool, runs } = harness(store);
    const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'try again' });
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.content);
    assert.equal(payload.delivered, true);
    assert.equal(payload.woke, true);
    assert.equal(payload.revivedFrom, status);
    assert.match(payload.note, new RegExp(`previous run had ${status}`));
    assert.equal(store.getSession(beta.canonicalSessionId).status, 'idle');
    assert.deepEqual(userText(store, beta.canonicalSessionId), [formatBotMessage(alpha, 'try again')]);
    assert.deepEqual(runs, [beta.canonicalSessionId]);
    store.db.close();
  });
}

test('failed background target resumes through reliable runner', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(beta.canonicalSessionId, { background: true, status: 'failed' });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'retry' });
  assert.equal(JSON.parse(result.content).woke, true);
  assert.deepEqual(runs, [beta.canonicalSessionId]);
  assert.deepEqual(store.dequeueSchedulerWakes(), []);
  store.db.close();
});

test('waiting_approval target accepts pending work without approving [AC:bot-reliable-messaging#AC-1]', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(beta.canonicalSessionId, { status: 'waiting_approval' });
  const approval = store.createApproval({
    sessionId: beta.canonicalSessionId,
    toolName: 'bash',
    args: { command: 'rm -rf x' },
    reason: 'needs approval'
  });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'ping' });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.queued, true);
  assert.equal(store.listApprovals({status:'pending'})[0].id, approval.id);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.equal(store.getSession(beta.canonicalSessionId).metadata.relayHop, undefined);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('in-process running registry queues delivery before status flips to running', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs, active } = harness(store);
  active.add(beta.canonicalSessionId);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'ping' });
  assert.equal(JSON.parse(result.content).queued, true);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('two senders racing for one idle target: exactly one write and one run', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const gamma = createBot(host, { name: 'Gamma' });
  const runs = [];
  const active = new Set();
  const tool = createMessageAgentTool({
    store,
    runSession: (sessionId) => {
      runs.push(sessionId);
      active.add(sessionId);
      return new Promise(() => {});
    },
    isSessionRunning: (sessionId) => active.has(sessionId),
    log: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const [r1, r2] = await Promise.all([
    call(tool, dir, store, alpha, { target: 'Gamma', message: 'from alpha' }),
    call(tool, dir, store, beta, { target: 'Gamma', message: 'from beta' })
  ]);
  const codes = [r1, r2].map((r) => JSON.parse(r.content).error_code ?? 'ok').sort();
  assert.deepEqual(codes, ['ok', 'ok']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM bot_work_messages WHERE status='pending'").get().n,1);
  assert.equal(userText(store, gamma.canonicalSessionId).length, 1);
  assert.deepEqual(runs, [gamma.canonicalSessionId]);
  store.db.close();
});

test('two running bots retain each others pending messages without parallel runs', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  store.updateSession(alpha.canonicalSessionId, { status: 'running' });
  store.updateSession(beta.canonicalSessionId, { status: 'running' });
  const { tool, runs } = harness(store);
  const [r1, r2] = await Promise.all([
    call(tool, dir, store, alpha, { target: 'Beta', message: 'hi beta' }),
    call(tool, dir, store, beta, { target: 'Alpha', message: 'hi alpha' })
  ]);
  assert.equal(JSON.parse(r1.content).queued, true);
  assert.equal(JSON.parse(r2.content).queued, true);
  assert.equal(userText(store, alpha.canonicalSessionId).length, 0);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('hidden own bots remain explicitly addressable [AC:default-super-bot#AC-4]', async () => {
 const {dir,store}=tempStore();const host=facadeHost(store);const alpha=createBot(host,{name:'Alpha'}),ghost=createBot(host,{name:'Ghost'});store.updateBot(ghost.id,{hidden:true});const {tool}=harness(store);
 const result=await call(tool,dir,store,alpha,{target:'Ghost',message:'psst',wake:false});assert.equal(result.ok,true);assert.equal(userText(store,ghost.canonicalSessionId).length,1);store.db.close();
});

test('cross-user delivery is refused; an ownerless bot does not spawn a personal chat [AC:bots#AC-2] [AC:unowned-legacy-bot#AC-2]', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const setOwner = (sessionId, meta) =>
    store.updateSession(sessionId, { metadata: { ...store.getSession(sessionId).metadata, ...meta } });
  const { tool, runs } = harness(store);

  const assertFilteredOut = (result) => {
    const payload = JSON.parse(result.content);
    assert.equal(payload.error_code, 'TARGET_OWNER_MISMATCH');
    assert.equal(payload.error, 'Target is not authorized for this principal');
    assert.equal('targetId' in payload, false);
  };

  setOwner(alpha.canonicalSessionId, { userId: 'user_a' });
  setOwner(beta.canonicalSessionId, { userId: 'user_b' });
  const crossed = await call(tool, dir, store, alpha, { target: 'Beta', message: 'leak?' });
  assertFilteredOut(crossed);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);

  setOwner(alpha.canonicalSessionId, { userId: undefined });
  const anon = await call(tool, dir, store, alpha, { target: 'Beta', message: 'anon?' });
  assertFilteredOut(anon);
  assert.deepEqual(runs, []);

  setOwner(alpha.canonicalSessionId, { userId: 'user_a', tenantId: 't1' });
  setOwner(beta.canonicalSessionId, { userId: 'user_a', tenantId: 't2' });
  const tenant = await call(tool, dir, store, alpha, { target: 'Beta', message: 'tenant?' });
  assertFilteredOut(tenant);

  setOwner(beta.canonicalSessionId, { userId: undefined, tenantId: undefined });
  setOwner(alpha.canonicalSessionId, { userId: 'user_a', tenantId: undefined });
  const before = store.listSessions().map((item) => item.id).sort();
  const legacy = await call(tool, dir, store, alpha, { target: 'Beta', message: 'legacy ok' });
  assert.equal(legacy.ok, false);
  assert.equal(JSON.parse(legacy.content).error_code, 'TARGET_OWNER_MISMATCH');
  assert.deepEqual(runs, []);
  assert.deepEqual(store.listSessions().map((item) => item.id).sort(), before);
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.equal(store.getSession(beta.canonicalSessionId).metadata.userId, undefined);
  store.db.close();
});

test('plan permission mode blocks message_agent', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const s = store.getSession(alpha.canonicalSessionId);
  store.updateSession(s.id, { metadata: { ...s.metadata, permissionMode: 'plan' } });
  const { tool, runs } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: 'Beta', message: 'nope' });
  assert.equal(JSON.parse(result.content).error_code, 'PERMISSION_MODE_PLAN');
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('task-mode and forged sessions are neither exposed nor callable', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const taskSession = store.createSession({
    title: 'Task',
    mode: 'task',
    agentId: alpha.id,
    metadata: { canonicalBotChat: true, botId: alpha.id }
  });
  assert.equal(isCanonicalBotChatSession(taskSession), false);
  const forged = store.createSession({
    title: 'Forged',
    mode: 'chat',
    agentId: 'general',
    metadata: { canonicalBotChat: true, botId: alpha.id }
  });
  const mismatched = store.createSession({
    title: 'Mismatch',
    mode: 'chat',
    agentId: alpha.id,
    metadata: { canonicalBotChat: true, botId: beta.id }
  });
  const { tool, runs } = harness(store);
  const t = await tool.execute(ctx(dir, taskSession, alpha), { target: 'Beta', message: 'x' });
  assert.equal(JSON.parse(t.content).error_code, 'NOT_CANONICAL');
  for (const session of [forged, mismatched]) {
    const r = await tool.execute(ctx(dir, session, alpha), { target: 'Beta', message: 'x' });
    assert.equal(JSON.parse(r.content).error_code, 'NOT_A_BOT');
  }
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('empty target lists the whole roster as a structured error', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  for (let i = 0; i < 10; i += 1) createBot(host, { name: `Peer${i}` });
  const { tool } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: '', message: 'x' });
  assert.equal(result.ok, false);
  const payload = JSON.parse(result.content);
  assert.equal(payload.error_code, 'TARGET_REQUIRED');
  assert.equal(payload.roster.length, 10);
  assert.equal(payload.rosterTotal, 10);
  store.db.close();
});

test('tool description tells the model about roster, fan-out, privacy and no reply', () => {
  const { store } = tempStore();
  const { tool } = harness(store);
  assert.match(tool.description, /empty target/);
  assert.match(tool.description, /fan out/);
  assert.match(tool.description, /private 1:1 chat/);
  assert.match(tool.description, /never returns their reply/);
  assert.match(tool.description, /wake=false/);
  assert.match(tool.description, /"FYI" in the message does not change it/);
  assert.equal(tool.inputSchema.properties.wake.type, 'boolean');
  assert.ok(!tool.inputSchema.required.includes('wake'));
  store.db.close();
});

test('startIdleSessionRun: non-idle is a no-op, failures are logged not thrown', async () => {
  const warns = [];
  const calls = [];
  const enq = [];
  const host = {
    store: { enqueueSchedulerWake: (id, reason) => enq.push([id, reason]) },
    log: { debug() {}, info() {}, warn: (m) => warns.push(m), error() {} },
    runSession: (id) => {
      calls.push(id);
      return Promise.reject(new Error('boom'));
    }
  };
  assert.equal(startIdleSessionRun(host, { id: 's1', status: 'running', background: false }, 'cron:x'), false);
  assert.equal(startIdleSessionRun(host, { id: 's1', status: 'waiting_approval', background: true }, 'cron:x'), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(enq, []);

  assert.equal(startIdleSessionRun(host, { id: 's2', status: 'idle', background: true }, 'cron:j1'), true);
  assert.deepEqual(enq, [['s2', 'cron:j1']]);

  assert.equal(startIdleSessionRun(host, { id: 's3', status: 'idle', background: false }, 'cron:j2'), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['s3']);
  assert.deepEqual(warns, ['cron session run failed']);

  const throwing = { ...host, runSession: () => { throw new Error('sync'); } };
  assert.equal(startIdleSessionRun(throwing, { id: 's4', status: 'idle', background: false }, 'message_agent:a'), true);
  assert.equal(warns.at(-1), 'idle session run failed');
});

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
  }
  async runTurn(input) {
    return this.handler(input);
  }
  async summarizeMessages() {
    return 'summary';
  }
}

async function settle(runtime, sessionId) {
  const s = await waitFor(() => {
    const cur = runtime.store.getSession(sessionId);
    return cur.status !== 'running' && !runtime.runningSessions.has(sessionId) ? cur : null;
  }, { intervalMs: 10 });
  if (!s) throw new Error('session did not settle');
  return s;
}

test('runtime: a failed Bot Chat re-runs on a plain user message (basis for message_agent reviving it)', async () => {
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ma-rerun-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ma-rerun-state-')),
    modelAdapter: new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'back again' }]
    }))
  });
  const bot = runtime.createBot({ name: 'Solo' });
  runtime.store.updateSession(bot.canonicalSessionId, { status: 'failed' });
  runtime.sendUserMessage(bot.canonicalSessionId, 'hello after failure');
  const after = await runtime.runSession(bot.canonicalSessionId);
  assert.equal(after.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(bot.canonicalSessionId), 'back again');
});

test('runtime: message_agent revives a failed peer and its run completes', async () => {
  const adapter = new ScriptedAdapter((input) => {
    const toolDone = input.messages.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.name === 'message_agent')
    );
    if (input.agent.name === 'Alpha' && !toolDone) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'ma1',
            name: 'message_agent',
            input: { target: 'Beta', message: 'please take over' }
          }
        ]
      };
    }
    return {
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: `${input.agent.name} done` }]
    };
  });
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ma-revive-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ma-revive-state-')),
    modelAdapter: adapter
  });
  const alpha = runtime.createBot({ name: 'Alpha' });
  const beta = runtime.createBot({ name: 'Beta' });
  runtime.store.updateSession(beta.canonicalSessionId, { status: 'failed' });
  runtime.sendUserMessage(alpha.canonicalSessionId, 'kick off');
  await runtime.runSession(alpha.canonicalSessionId);
  const resultPart = runtime
    .getSessionMessages(alpha.canonicalSessionId)
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool_result' && p.name === 'message_agent');
  assert.ok(resultPart);
  const payload = JSON.parse(resultPart.content);
  assert.equal(payload.woke, true);
  assert.equal(payload.revivedFrom, 'failed');
  const betaAfter = await settle(runtime, beta.canonicalSessionId);
  assert.equal(betaAfter.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(beta.canonicalSessionId), 'Beta done');
});

test('readRelayHop accepts finite numbers and integer strings only', () => {
  assert.equal(readRelayHop({ relayHop: 2.9 }), 2);
  assert.equal(readRelayHop({ relayHop: -4 }), 0);
  assert.equal(readRelayHop({ relayHop: Infinity }), 0);
  assert.equal(readRelayHop({ relayHop: Number.NaN }), 0);
  assert.equal(readRelayHop({ relayHop: ' 2 ' }), 2);
  assert.equal(readRelayHop({ relayHop: '-3' }), 0);
  assert.equal(readRelayHop({ relayHop: '2.5' }), 0);
  assert.equal(readRelayHop({ relayHop: 'two' }), 0);
  assert.equal(readRelayHop({ relayHop: true }), 0);
  assert.equal(readRelayHop({}), 0);
  assert.equal(readRelayHop(undefined), 0);
});

test('wantsWake only treats explicit opt-outs as false', () => {
  for (const off of [false, null, 0, 'false', ' NO ', '0', 'False']) {
    assert.equal(wantsWake(off), false, JSON.stringify(off));
  }
  for (const on of [true, undefined, 1, 'yes', '', 'true', {}]) {
    assert.equal(wantsWake(on), true, JSON.stringify(on));
  }
});

test('isSilenceToken matches every token regardless of spacing and case', () => {
  for (const body of ['SILENT', ' silent ', '[SILENT]', 'NO_REPLY', 'no   reply', 'No\tReply']) {
    assert.equal(isSilenceToken(body), true, body);
  }
  assert.equal(isSilenceToken('silently'), false);
});

test('effectiveRelayHop counts the relayed message even after assistant replies', () => {
  const { store } = tempStore();
  const bot = createBot(facadeHost(store), { name: 'Alpha' });
  const sid = bot.canonicalSessionId;
  const relayed = store.appendMessage(sid, 'user', [{ type: 'text', text: 'relayed' }]);
  store.appendMessage(sid, 'assistant', [{ type: 'text', text: 'on it' }]);
  const s = store.getSession(sid);
  store.updateSession(sid, { metadata: { ...s.metadata, relayHop: 2, relayHopMessageId: relayed.id } });
  assert.equal(effectiveRelayHop(store, store.getSession(sid)), 2);
  store.db.close();
});

test('message_agent declares target and message as required arguments', () => {
  const { store } = tempStore();
  const { tool } = harness(store);
  assert.deepEqual(tool.inputSchema.required, ['target', 'message']);
  store.db.close();
});

test('blank message is rejected before anything is written', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool, runs } = harness(store);
  for (const message of ['', '   ', undefined, 42]) {
    const payload = await failure(call(tool, dir, store, alpha, { target: 'Beta', message }));
    assert.equal(payload.error_code, 'MESSAGE_REQUIRED');
  }
  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  assert.deepEqual(runs, []);
  store.db.close();
});

test('a message of exactly the maximum length is delivered; one more char is refused', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool } = harness(store);
  const ok = await call(tool, dir, store, alpha, { target: 'Beta', message: 'x'.repeat(MESSAGE_MAX_CHARS) });
  assert.equal(ok.ok, true);
  const payload = await failure(
    call(tool, dir, store, alpha, { target: 'Beta', message: 'y'.repeat(MESSAGE_MAX_CHARS + 1) })
  );
  assert.equal(payload.error_code, 'MESSAGE_TOO_LONG');
  assert.equal(userText(store, beta.canonicalSessionId).length, 1);
  store.db.close();
});

test('an idle target is woken without being reported as revived', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  createBot(host, { name: 'Beta' });
  const { tool } = harness(store);
  const result = await call(tool, dir, store, alpha, { target: '@Beta', message: 'ping' });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.content);
  assert.equal(payload.startedRun, true);
  assert.equal('revivedFrom' in payload, false);
  assert.equal('skippedRun' in payload, false);
  assert.doesNotMatch(payload.note, /restarted/);
  store.db.close();
});

test('targets resolve by case-insensitive id or name when the bot id differs from its name', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const office = createBot(host, { name: 'Office Manager' });
  assert.equal(office.id, 'office-manager');
  const { tool } = harness(store);
  for (const target of ['OFFICE-MANAGER', 'office manager', '@@Office Manager']) {
    const result = await call(tool, dir, store, alpha, { target, message: `via ${target}` });
    assert.equal(result.ok, true, target);
    assert.equal(JSON.parse(result.content).targetId, office.id);
  }
  store.db.close();
});

test('did_you_mean falls back from names to ids and strips leading @', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const cn = createBot(host, { name: '调研助手' });
  assert.match(cn.id, /^bot/);
  const { tool } = harness(store);

  const byName = await failure(call(tool, dir, store, alpha, { target: '调研助', message: 'hi' }));
  assert.equal(byName.error_code, 'UNKNOWN_TARGET');
  assert.equal(byName.did_you_mean, '调研助手');

  const typoId = `${cn.id.slice(0, -1)}${cn.id.endsWith('z') ? 'y' : 'z'}`;
  const byId = await failure(call(tool, dir, store, alpha, { target: typoId, message: 'hi' }));
  assert.equal(byId.did_you_mean, '调研助手');

  const researcher = createBot(host, { name: 'Researcher' });
  const atTypo = await failure(call(tool, dir, store, alpha, { target: '@@@@@@Reseacher', message: 'hi' }));
  assert.equal(atTypo.did_you_mean, researcher.name);

  const none = await failure(call(tool, dir, store, alpha, { target: 'zzzz-qqqq-not-a-bot', message: 'hi' }));
  assert.equal(none.error_code, 'UNKNOWN_TARGET');
  assert.equal(none.did_you_mean, null);
  store.db.close();
});

test('a hidden sender targeting itself gets SELF_TARGET, not UNKNOWN_TARGET', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  createBot(host, { name: 'Beta' });
  updateBot(host, alpha.id, { hidden: true });
  const { tool } = harness(store);
  const payload = await failure(call(tool, dir, store, alpha, { target: 'Alpha', message: 'me' }));
  assert.equal(payload.error_code, 'SELF_TARGET');
  store.db.close();
});

test('missing or invalid canonical binding repairs only target context [AC:bot-identity-continuity#AC-1]',async()=>{
 const {dir,store}=tempStore();const host=facadeHost(store);const alpha=createBot(host,{name:'Alpha'}),beta=createBot(host,{name:'Beta'});const {tool}=harness(store);store.deleteSession(beta.canonicalSessionId);
 const result=await call(tool,dir,store,alpha,{target:'Beta',message:'hi',wake:false});assert.equal(result.ok,true);const target=store.getSession(JSON.parse(result.content).sessionId);assert.equal(target.agentId,beta.id);assert.equal(userText(store,target.id).length,1);assert.equal(userText(store,alpha.canonicalSessionId).length,0);store.db.close();
});

test('delivery failures inside the store become a structured DELIVERY_FAILED result', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  createBot(host, { name: 'Beta' });
  const broken = Object.create(store);
  broken.appendMessage = () => {
    throw new Error('disk full');
  };
  const tool = createMessageAgentTool({
    store: broken,
    runSession: async () => undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const payload = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'hi' }));
  assert.equal(payload.error_code, 'DELIVERY_FAILED');
  assert.equal(payload.error, 'disk full');

  broken.appendMessage = () => {
    throw 'raw failure';
  };
  const raw = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'hi' }));
  assert.equal(raw.error, 'raw failure');
  store.db.close();
});

test('refusals report ok:false for no-bot, plan mode, unknown target and owner mismatch', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const beta = createBot(host, { name: 'Beta' });
  const { tool } = harness(store);

  const orphan = store.createSession({
    title: 'Orphan',
    mode: 'chat',
    agentId: 'general',
    metadata: { canonicalBotChat: true }
  });
  const noBot = await failure(tool.execute(ctx(dir, orphan, alpha), { target: 'Beta', message: 'hi' }));
  assert.equal(noBot.error_code, 'NOT_A_BOT');

  assert.equal((await failure(call(tool, dir, store, alpha, { target: 'Nobody', message: 'hi' }))).error_code, 'UNKNOWN_TARGET');

  const betaSession = store.getSession(beta.canonicalSessionId);
  store.updateSession(betaSession.id, { metadata: { ...betaSession.metadata, userId: 'someone_else' } });
  const owner = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'hi' }));
  assert.equal(owner.error_code, 'TARGET_OWNER_MISMATCH');

  const sender = store.getSession(alpha.canonicalSessionId);
  store.updateSession(sender.id, { metadata: { ...sender.metadata, permissionMode: 'plan' } });
  const plan = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'hi' }));
  assert.equal(plan.error_code, 'PERMISSION_MODE_PLAN');

  assert.equal(userText(store, beta.canonicalSessionId).length, 0);
  store.db.close();
});

test('message_agent catches early store failures as structured errors', async () => {
  const { dir, store } = tempStore();
  try {
    const alpha = createBot(facadeHost(store), { name: 'Alpha' });
    const broken = Object.create(store);
    const { tool } = harness(broken);
    for (const thrown of [new Error('read failed'), 'raw read failure']) {
      broken.getSession = () => { throw thrown; };
      const result = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'hi' }));
      assert.equal(result.error_code, 'DELIVERY_FAILED');
      assert.equal(result.error, thrown instanceof Error ? thrown.message : thrown);
    }
  } finally { store.db.close(); }
});

test('an exact bot id wins over another bot whose name is that id', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const sender = createBot(host, { name: 'Sender' });
  const byId = createBot(host, { name: 'Hello World' });
  const byName = createBot(host, { name: 'hello-world' });
  assert.equal(byId.id, 'hello-world');
  assert.notEqual(byName.id, byId.id);
  const { tool } = harness(store);
  const result = await call(tool, dir, store, sender, { target: 'hello-world', message: 'to the id', wake: false });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.content).targetId, byId.id);
  assert.equal(userText(store, byId.canonicalSessionId).length, 1);
  assert.equal(userText(store, byName.canonicalSessionId).length, 0);
  store.db.close();
});

test('an exact bot name wins over a case-insensitive id of a different bot', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const sender = createBot(host, { name: 'Sender' });
  const ciId = createBot(host, { name: 'foo' });
  store.db.prepare('UPDATE bots SET name = ? WHERE id = ?').run('keeper', ciId.id);
  const exactName = createBot(host, { name: 'Foo' });
  assert.equal(ciId.id, 'foo');
  assert.notEqual(exactName.id, ciId.id);
  const { tool } = harness(store);
  const result = await call(tool, dir, store, sender, { target: 'Foo', message: 'to the name', wake: false });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.content).targetId, exactName.id);
  assert.equal(userText(store, exactName.canonicalSessionId).length, 1);
  assert.equal(userText(store, ciId.canonicalSessionId).length, 0);
  store.db.close();
});

test('a hidden bot owned by someone else is an owner mismatch, not an unknown target', async () => {
  const { dir, store } = tempStore();
  const host = facadeHost(store);
  const alpha = createBot(host, { name: 'Alpha' });
  const ghost = createBot(host, { name: 'Ghost' });
  updateBot(host, ghost.id, { hidden: true });
  const ghostSession = store.getSession(ghost.canonicalSessionId);
  store.updateSession(ghost.canonicalSessionId, {
    metadata: { ...ghostSession.metadata, userId: 'user_b' }
  });
  const { tool } = harness(store);
  const payload = await failure(call(tool, dir, store, alpha, { target: 'Ghost', message: 'psst' }));
  assert.equal(payload.error_code, 'TARGET_OWNER_MISMATCH');
  assert.equal(payload.error, 'Target is not authorized for this principal');
  assert.equal('targetId' in payload, false);
  store.db.close();
});

test('message_agent reports queue capacity and retains already accepted work', async () => {
  const { dir, store } = tempStore();
  try {
    const host = facadeHost(store);
    const alpha = createBot(host, { name: 'Alpha' });
    const beta = createBot(host, { name: 'Beta' });
    store.setDaemonControl('bot.workSettings', { perBot: 1, perPrincipal: 1 });
    const { tool, active } = harness(store);
    active.add(beta.canonicalSessionId);
    const first = await call(tool, dir, store, alpha, { target: 'Beta', message: 'first' });
    assert.equal(first.ok, true);
    const overflow = await failure(call(tool, dir, store, alpha, { target: 'Beta', message: 'overflow' }));
    assert.equal(overflow.error_code, 'QUEUE_FULL');
    assert.equal(overflow.accepted, false);
    assert.equal(overflow.retryable, true);
    assert.match(overflow.error, /Pending work capacity reached/);
    assert.deepEqual(overflow.limits, { perBot: 1, perPrincipal: 1 });
    assert.deepEqual(overflow.usage, { total: 1, byBot: { [beta.id]: 1 } });
  } finally { store.db.close(); }
});
