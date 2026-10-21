import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { planConcurrentBotForks, coordinatorViewOf, pendingBotWorkPieces } from '../dist/bots/concurrent-fork.js';
import { compileTurnAppendix } from '../dist/session/context-compiler.js';
import { createMemoryTools } from '../dist/tools/memory-tools.js';
import { createHistoryTools } from '../dist/session/history/tools.js';
import { createToolServices } from '../dist/runtime/tool-services.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { SUBAGENT_DENIED_TOOLS } from '../dist/runtime/subagent-policy.js';

function runtimeWith(adapter) {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'bot-fork-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'bot-fork-state-')),
    modelAdapter: adapter
  });
}

function adapterHolding(parentId, gate) {
  return {
    name: 'fork-script',
    async runTurn(input) {
      if (input.sessionId !== parentId.current) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'child-done' }] };
      }
      await gate.promise;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent-done' }] };
    },
    async summarizeMessages() {
      return 'summary';
    }
  };
}

function subsOf(runtime, parentId) {
  return runtime.listSessions().filter((session) => session.mode === 'subagent' && session.parentSessionId === parentId);
}

async function settle(runtime, parentId) {
  for (let i = 0; i < 50; i += 1) {
    const children = subsOf(runtime, parentId);
    if (children.length === 0 || children.every((child) => child.status !== 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('plan keeps a single in-flight turn and forks every extra piece [AC:bot-concurrent-subagents#AC-1] [AC:bot-concurrent-subagents#AC-2]', () => {
  const only = planConcurrentBotForks({
    inFlight: true,
    activePieceId: 'turn',
    pending: [{ id: 'turn', text: 'one' }]
  });
  assert.deepEqual(only.forks, []);
  assert.equal(
    planConcurrentBotForks({ inFlight: false, pending: [{ id: 'only', text: 'one' }] }).forks.length,
    0
  );
  const idle = planConcurrentBotForks({
    inFlight: false,
    pending: [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
      { id: 'c', text: 'third' }
    ]
  });
  assert.equal(idle.parentPieceId, 'a');
  assert.deepEqual(idle.forks.map((piece) => piece.id), ['b', 'c']);
  const busy = planConcurrentBotForks({
    inFlight: true,
    activePieceId: 'a',
    pending: [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' }
    ]
  });
  assert.deepEqual(busy.forks.map((piece) => piece.id), ['b']);
});

test('one in-flight bot turn does not fork a sub-agent [AC:bot-concurrent-subagents#AC-1]', async () => {
  const parentId = { current: '' };
  let release = () => {};
  const gate = {};
  gate.promise = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = runtimeWith(adapterHolding(parentId, gate));
  try {
    const bot = runtime.createBot({ name: 'Solo' });
    const session = runtime.getSession(runtime.openBot(bot.id).sessionId);
    parentId.current = session.id;
    runtime.sendUserMessage(session.id, 'only this turn', { autoRun: true });
    const running = runtime.runHumanSession(session.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subsOf(runtime, session.id).length, 0);
    assert.equal(runtime.getSession(session.id).mode, 'chat');
    release();
    await running;
    assert.equal(subsOf(runtime, session.id).length, 0);
  } finally {
    release();
    await runtime.destroy();
  }
});

test('two or more concurrent bot pieces inherit bypass and the parent stays coordinator [AC:bot-concurrent-subagents#AC-2] [AC:bot-task-permission-inheritance#AC-2]', async () => {
  const parentId = { current: '' };
  let release = () => {};
  const gate = {};
  gate.promise = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = runtimeWith(adapterHolding(parentId, gate));
  try {
    const bot = runtime.createBot({ name: 'Coordinator' });
    const session = runtime.getSession(runtime.openBot(bot.id).sessionId);
    runtime.store.updateSession(session.id, { metadata: { ...session.metadata, permissionMode: 'bypass' } });
    parentId.current = session.id;
    runtime.sendUserMessage(session.id, 'keep on the parent', { autoRun: true });
    runtime.sendUserMessage(session.id, 'extra piece alpha', { autoRun: true });
    runtime.sendUserMessage(session.id, 'extra piece beta', { autoRun: true });
    const running = runtime.runHumanSession(session.id);
    await new Promise((resolve) => setImmediate(resolve));
    const children = subsOf(runtime, session.id);
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.metadata.permissionMode === 'bypass'));
    const prompts = children.map((child) => JSON.stringify(runtime.store.foldMessages(child.id)));
    assert.equal(prompts.some((text) => text.includes('extra piece alpha')), true);
    assert.equal(prompts.some((text) => text.includes('extra piece beta')), true);
    assert.equal(prompts.some((text) => text.includes('keep on the parent')), false);
    const parent = runtime.getSession(session.id);
    assert.equal(parent.mode, 'chat');
    assert.equal(parent.metadata.canonicalBotChat, true);
    assert.equal(children.every((child) => child.metadata.canonicalBotChat !== true), true);
    const viewed = coordinatorViewOf(parent, runtime.store.foldMessages(session.id));
    const extra = viewed.find((message) => message.parts.some((part) => part.type === 'text' && part.text.includes('extra piece alpha')));
    assert.ok(extra);
    assert.match(extra.parts[0].text, /协调/);
    assert.equal(runtime.store.foldMessages(session.id).some((message) => message.parts.some((part) => part.type === 'text' && part.text === 'extra piece alpha')), true);
    release();
    await running;
    await settle(runtime, session.id);
  } finally {
    release();
    await runtime.destroy();
  }
});

test('a second piece arriving during an in-flight turn forks exactly that piece [AC:bot-concurrent-subagents#AC-1] [AC:bot-concurrent-subagents#AC-2]', async () => {
  const parentId = { current: '' };
  let release = () => {};
  const gate = {};
  gate.promise = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = runtimeWith(adapterHolding(parentId, gate));
  try {
    const bot = runtime.createBot({ name: 'Busy' });
    const session = runtime.getSession(runtime.openBot(bot.id).sessionId);
    parentId.current = session.id;
    runtime.sendUserMessage(session.id, 'already running', { autoRun: true });
    const running = runtime.runHumanSession(session.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subsOf(runtime, session.id).length, 0);
    runtime.sendUserMessage(session.id, 'arrived while busy', { autoRun: true });
    runtime.runHumanSession(session.id);
    await new Promise((resolve) => setImmediate(resolve));
    const children = subsOf(runtime, session.id);
    assert.equal(children.length, 1);
    assert.match(JSON.stringify(runtime.store.foldMessages(children[0].id)), /arrived while busy/);
    assert.equal(runtime.getSession(session.id).mode, 'chat');
    release();
    await running;
    await settle(runtime, session.id);
  } finally {
    release();
    await runtime.destroy();
  }
});

function memoryStore() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sub-mem-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const now = new Date().toISOString();
  store.createBot({
    id: 'bot-a',
    name: 'Alpha',
    title: 'Alpha',
    description: '',
    agentId: 'bot-a',
    canonicalSessionId: 'canon-a',
    hidden: false,
    createdAt: now,
    updatedAt: now
  });
  store.createBot({
    id: 'bot-b',
    name: 'Beta',
    title: 'Beta',
    description: '',
    agentId: 'bot-b',
    canonicalSessionId: 'canon-b',
    hidden: false,
    createdAt: now,
    updatedAt: now
  });
  return { dir, store };
}

test('sub-agent context and memory search reuse parent notes and global bot memory [AC:bot-concurrent-subagents#AC-3]', async () => {
  const { dir, store } = memoryStore();
  try {
    const am = store.agentMemory();
    saveSemanticFact(am, { userId: 'u1', category: 'fact', content: '全局蓝鲸备忘', agentId: 'bot-a' });
    saveSemanticFact(am, { userId: 'u1', category: 'fact', content: '贝塔白鲸备忘', agentId: 'bot-b' });
    saveSemanticFact(am, { userId: 'u1', category: 'fact', content: '共享珊瑚备忘' });
    const parent = store.createSession({
      title: 'parent',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { botId: 'bot-a', canonicalBotChat: true, userId: 'u1' }
    });
    store.upsertSessionMemory({ sessionId: parent.id, scope: 'scratch', key: 'parent.note', value: '父级蓝鲸备忘' });
    store.appendMessage(parent.id, 'user', [{ type: 'text', text: '父会话上下文里的蓝鲸航线' }]);
    const other = store.createSession({
      title: 'other',
      mode: 'chat',
      agentId: 'bot-b',
      metadata: { botId: 'bot-b', canonicalBotChat: true, userId: 'u1' }
    });
    store.appendMessage(other.id, 'user', [{ type: 'text', text: '其他机器人的私有航线' }]);
    const child = store.createSession({
      title: 'child',
      mode: 'subagent',
      agentId: 'reviewer',
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, userId: 'u1', botId: 'bot-a' }
    });
    const services = createToolServices({
      store,
      stateDir: dir,
      resolveSkillLoad: async () => ({}),
      resolveSkillSearch: async () => ({ content: '' }),
      unblockDependentTasks: async () => {},
      spawnSubagent: async () => '',
      spawnTeammate: async () => '',
      startBackgroundJob: async () => ({})
    });
    const memorySearch = createMemoryTools(services).find((tool) => tool.name === 'memory_search');
    const historySearch = createHistoryTools(store).find((tool) => tool.name === 'history_search');
    const ctx = {
      repoRoot: dir,
      stateDir: dir,
      session: store.getSession(child.id),
      agent: { id: 'reviewer', name: 'reviewer', role: 'review', instructions: '', capabilities: [] }
    };
    const memory = JSON.parse((await memorySearch.execute(ctx, { query: '蓝鲸备忘' })).content);
    const memoryText = JSON.stringify(memory);
    assert.match(memoryText, /父级蓝鲸备忘/);
    assert.match(memoryText, /全局蓝鲸备忘/);
    assert.doesNotMatch(memoryText, /白鲸/);
    assert.doesNotMatch(memoryText, /珊瑚/);
    const history = JSON.parse((await historySearch.execute(ctx, { query: '蓝鲸' })).content);
    assert.equal(history.memories.some((hit) => hit.origin === 'parent' && hit.excerpt.includes('父级蓝鲸备忘')), true);
    assert.equal(history.memories.some((hit) => hit.origin === 'global' && hit.excerpt.includes('全局蓝鲸备忘')), true);
    assert.equal(JSON.stringify(history).includes('父会话上下文'), false);
    assert.equal(JSON.stringify(history).includes('其他机器人'), false);
    assert.equal(JSON.stringify(history).includes('白鲸'), false);
    const historyRead = createHistoryTools(store).find((tool) => tool.name === 'history_read');
    const parentMessage = store.foldMessages(parent.id).find((message) => message.role === 'user');
    assert.equal((await historyRead.execute(ctx, { ref: `history:${parent.id}:${parentMessage.id}:0` })).ok, false);
    const appendix = compileTurnAppendix({ session: store.getSession(child.id), query: '蓝鲸备忘', store });
    assert.match(appendix, /父级蓝鲸备忘/);
    assert.match(appendix, /全局蓝鲸备忘/);
    assert.doesNotMatch(appendix, /白鲸/);
    assert.doesNotMatch(appendix, /珊瑚/);
  } finally {
    store.db.close();
  }
});

test('sub-agent help reaches parent and siblings only and cannot send IM, cron, or overwrite parent memory [AC:bot-concurrent-subagents#AC-4]', async () => {
  const runtime = runtimeWith({
    name: 'idle',
    async runTurn() {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    },
    async summarizeMessages() {
      return '';
    }
  });
  try {
    const bot = runtime.createBot({ name: 'Family' });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    const kept = '父记忆保持不变';
    runtime.store.agentMemory().set({
      scope: 'user.memory',
      namespace: 'semantic',
      key: 'fact:kept',
      value: kept,
      userId: parent.metadata.userId,
      agentId: bot.agentId,
      importance: 0.9,
      confidence: 'high',
      source: 'user_provided'
    });
    const child = runtime.store.createSession({
      title: 'child',
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: {
        parentSessionId: parent.id,
        botId: parent.metadata.botId,
        userId: parent.metadata.userId,
        tenantId: parent.metadata.tenantId
      }
    });
    const sibling = runtime.store.createSession({
      title: 'sibling',
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: {
        parentSessionId: parent.id,
        botId: parent.metadata.botId,
        userId: parent.metadata.userId,
        tenantId: parent.metadata.tenantId
      }
    });
    const outsider = runtime.createBot({ name: 'Outsider' });
    const foreign = runtime.getSession(runtime.openBot(outsider.id).sessionId);
    const agent = runtime.store.getAgent(parent.agentId);
    const childTools = filterToolsForSession({
      env: process.env,
      tools: runtime.tools,
      agent,
      session: runtime.getSession(child.id),
      settingsStore: runtime.store
    }).tools;
    const parentTools = filterToolsForSession({
      env: process.env,
      tools: runtime.tools,
      agent,
      session: parent,
      settingsStore: runtime.store
    }).tools;
    const childNames = childTools.map((tool) => tool.name);
    for (const denied of SUBAGENT_DENIED_TOOLS) assert.equal(childNames.includes(denied), false, denied);
    assert.equal(childNames.includes('ask_bot_help'), true);
    assert.equal(childNames.includes('memory_get'), true);
    assert.equal(parentTools.some((tool) => tool.name === 'ask_bot_help'), false);
    assert.equal(parentTools.some((tool) => tool.name === 'message_agent'), true);
    const help = childTools.find((tool) => tool.name === 'ask_bot_help');
    const result = await help.execute(
      {
        repoRoot: runtime.repoRoot,
        stateDir: runtime.stateDir,
        session: runtime.getSession(child.id),
        agent
      },
      { message: '请父代理和兄弟确认蓝鲸步骤' }
    );
    assert.equal(result.ok, true);
    const body = JSON.parse(result.content);
    assert.deepEqual(body.delivered.sort(), [parent.id, sibling.id].sort());
    const has = (sessionId) =>
      runtime.store.foldMessages(sessionId).some((message) =>
        message.parts.some((part) => part.type === 'text' && part.text.includes('请父代理和兄弟确认蓝鲸步骤'))
      );
    assert.equal(has(parent.id), true);
    assert.equal(has(sibling.id), true);
    assert.equal(has(foreign.id), false);
    assert.equal(runtime.store.listMailbox(parent.agentId, false).length, 0);
    assert.equal(runtime.listCronJobs().length, 0);
    const still = runtime.store.agentMemory().search({
      scope: 'user.memory',
      userId: parent.metadata.userId,
      agentId: bot.agentId,
      limit: 10
    });
    assert.equal(still.some((row) => row.value === kept), true);
    assert.equal(still.length, 1);
  } finally {
    await runtime.destroy();
  }
});

// ── isolation guards ──────────────────────────────────────────────────────────

test('subagent-help: sibling with different userId is dropped [AC:bot-concurrent-subagents#AC-4]', async () => {
  const runtime = runtimeWith({
    name: 'idle',
    async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }; },
    async summarizeMessages() { return ''; }
  });
  try {
    const bot = runtime.createBot({ name: 'FamilyIsolation' });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    // child belongs to userA (same as parent)
    const child = runtime.store.createSession({
      title: 'child-a',
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: parent.metadata.botId, userId: 'userA', tenantId: undefined }
    });
    // sameUserSibling belongs to userA — must be included
    const sameUserSibling = runtime.store.createSession({
      title: 'sibling-same',
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: parent.metadata.botId, userId: 'userA', tenantId: undefined }
    });
    // otherUserSibling belongs to userB — must be excluded
    const otherUserSibling = runtime.store.createSession({
      title: 'sibling-other',
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: parent.metadata.botId, userId: 'userB', tenantId: undefined }
    });
    const { subagentHelpTargets } = await import('../dist/runtime/subagent-help.js');
    const targets = subagentHelpTargets(runtime.store, runtime.store.getSession(child.id), 'siblings');
    const ids = targets.map((s) => s.id);
    assert.equal(ids.includes(sameUserSibling.id), true, 'same-user sibling must be included');
    assert.equal(ids.includes(otherUserSibling.id), false, 'different-user sibling must be dropped');
    assert.equal(ids.includes(child.id), false, 'self must not appear');
  } finally {
    await runtime.destroy();
  }
});

test('subagent-help same-owner: userId on either side must match, tenant only when neither has a user', async () => {
  const runtime = runtimeWith({
    name: 'idle',
    async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }; },
    async summarizeMessages() { return ''; }
  });
  try {
    const bot = runtime.createBot({ name: 'OwnerMatch' });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    const make = (title, extra) => runtime.store.createSession({
      title,
      mode: 'subagent',
      agentId: parent.agentId,
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: parent.metadata.botId, ...extra }
    });
    const askerUser = make('asker-user', { userId: 'A', tenantId: 'T' });
    const askerTenant = make('asker-tenant', { tenantId: 'T' });
    const sibTenant = make('sib-tenant', { tenantId: 'T' });
    const sibUserB = make('sib-user-b', { userId: 'B', tenantId: 'T' });
    const { subagentHelpTargets } = await import('../dist/runtime/subagent-help.js');
    const ids = (session) => subagentHelpTargets(runtime.store, runtime.store.getSession(session.id), 'siblings').map((row) => row.id);
    const fromUser = ids(askerUser);
    assert.equal(fromUser.includes(sibTenant.id), false, '{userId:A,tenantId:T} vs {tenantId:T} is not the same owner');
    assert.equal(fromUser.includes(sibUserB.id), false, 'different users never match');
    const fromTenant = ids(askerTenant);
    assert.equal(fromTenant.includes(sibTenant.id), true, 'both without userId and the same tenant match');
    assert.equal(fromTenant.includes(askerUser.id), false, '{tenantId:T} vs {userId:A,tenantId:T} is not the same owner');
    assert.equal(fromTenant.includes(sibUserB.id), false, 'different users never match');
  } finally {
    await runtime.destroy();
  }
});

test('subagent-recall: tenant-only session cannot retrieve another user\'s user.memory [AC:bot-concurrent-subagents#AC-3]', async () => {
  const { store } = memoryStore();
  try {
    // Store a fact owned by userX under bot-a
    const am = store.agentMemory();
    am.set({
      scope: 'user.memory',
      namespace: 'semantic',
      key: 'fact:userX-secret',
      value: 'userX 的秘密记忆',
      userId: 'userX',
      tenantId: 'tenant1',
      agentId: 'bot-a',
      importance: 0.9,
      confidence: 'high',
      source: 'user_provided'
    });
    // A tenant-only session (no userId) should NOT find userX's row
    const parent = store.createSession({
      title: 'parent-tenant',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { botId: 'bot-a', canonicalBotChat: true, tenantId: 'tenant1' }
    });
    const child = store.createSession({
      title: 'child-tenant',
      mode: 'subagent',
      agentId: 'reviewer',
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: 'bot-a', tenantId: 'tenant1' }
    });
    const { collectSubagentMemoryHits } = await import('../dist/memory/subagent-recall.js');
    const hits = collectSubagentMemoryHits(store, store.getSession(child.id), 'userX');
    assert.equal(hits.some((h) => h.excerpt.includes('userX 的秘密记忆')), false,
      'tenant-only session must not get userX rows');
  } finally {
    store.db.close();
  }
});

test('subagent-recall: ownerless legacy session still retrieves user_id IS NULL bot memory [AC:bot-concurrent-subagents#AC-3]', async () => {
  const { store } = memoryStore();
  try {
    // Store a fact with no userId (legacy ownerless row)
    const am = store.agentMemory();
    am.set({
      scope: 'user.memory',
      namespace: 'semantic',
      key: 'fact:legacy',
      value: '无主旧记忆',
      agentId: 'bot-a',
      importance: 0.9,
      confidence: 'high',
      source: 'user_provided'
    });
    const parent = store.createSession({
      title: 'parent-legacy',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { botId: 'bot-a', canonicalBotChat: true }
    });
    const child = store.createSession({
      title: 'child-legacy',
      mode: 'subagent',
      agentId: 'reviewer',
      parentSessionId: parent.id,
      metadata: { parentSessionId: parent.id, botId: 'bot-a' }
    });
    const { collectSubagentMemoryHits } = await import('../dist/memory/subagent-recall.js');
    const hits = collectSubagentMemoryHits(store, store.getSession(child.id), '无主');
    assert.equal(hits.some((h) => h.excerpt.includes('无主旧记忆')), true,
      'ownerless session must still find user_id IS NULL bot memory');
  } finally {
    store.db.close();
  }
});

test('pendingBotWorkPieces skips the transcript fold when no human work is waiting [hot-path]', () => {
  const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), 'bot-fork-pieces-')), 'state.db'));
  const session = store.createSession({ title: 'pieces', mode: 'chat', agentId: 'general', metadata: { canonicalBotChat: true } });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'old ask' }]);
  let folds = 0;
  const fold = store.foldMessages.bind(store);
  store.foldMessages = (id) => { folds += 1; return fold(id); };
  assert.deepEqual(pendingBotWorkPieces(store, session.id), []);
  assert.equal(folds, 0);
  store.db.close();
});
