import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { compileTurnAppendix } from '../dist/session/context-compiler.js';
import { appendWorkingLogEntry, workingLogPath } from '../dist/session/working-log.js';

const PHRASE = 'PARENT_PHRASE_QINGLAN_7F3A';
const DUTY = 'DUTY_QINGLAN_HARBOR_77';
const OTHER_DUTY = 'DUTY_OTHERBOT_SECRET_88';
const EMPTY = '没有找到';

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

function runtimeWith(adapter) {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'fork-retrieval-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'fork-retrieval-state-')),
    modelAdapter: adapter
  });
}

function idleRuntime() {
  return runtimeWith({
    name: 'idle',
    async runTurn() {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    },
    async summarizeMessages() {
      return '';
    }
  });
}

function fullText(token) {
  return `${token} ${'详'.repeat(240)} END_${token}`;
}

function tool(runtime, name) {
  const found = runtime.tools.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

function ctx(runtime, session) {
  return {
    repoRoot: runtime.repoRoot,
    stateDir: runtime.stateDir,
    session,
    agent: runtime.store.getAgent(session.agentId) ?? {
      id: session.agentId,
      name: session.agentId,
      role: 'research',
      instructions: '',
      capabilities: []
    }
  };
}

function childOf(runtime, parent, extra = {}) {
  return runtime.store.createSession({
    title: 'child',
    mode: 'subagent',
    agentId: 'researcher',
    parentSessionId: parent.id,
    metadata: {
      botId: parent.metadata.botId,
      parentSessionId: parent.id,
      userId: parent.metadata.userId,
      tenantId: parent.metadata.tenantId,
      ...extra
    }
  });
}

test('forked bot child opens on the task and can look up a parent sentence [AC:bot-fork-retrievable-inheritance#AC-1]', async () => {
  const box = { parentId: '' };
  const childViews = [];
  const runtime = runtimeWith(
    new ScriptedAdapter((input) => {
      if (input.sessionId !== box.parentId) {
        childViews.push({
          systemPrompt: input.systemPrompt ?? '',
          text: JSON.stringify(input.messages)
        });
        const sawSearch = input.messages.some((message) =>
          message.parts.some((part) => part.type === 'tool_result' && part.name === 'history_search')
        );
        if (!sawSearch) {
          return {
            stopReason: 'tool_use',
            assistantParts: [
              {
                type: 'tool_call',
                toolCallId: 'find-parent',
                name: 'history_search',
                input: { query: PHRASE }
              }
            ]
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'child-final-summary' }] };
      }
      const spawned = input.messages.some((message) =>
        message.parts.some((part) => part.type === 'tool_result' && part.name === 'spawn_subagent')
      );
      if (!spawned) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'spawn-1',
              name: 'spawn_subagent',
              input: { prompt: 'delegated task only', role: 'research' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
    })
  );
  try {
    const bot = runtime.createBot({ name: 'Qinglan', description: DUTY });
    const opened = runtime.openBot(bot.id);
    box.parentId = opened.sessionId;
    runtime.store.appendMessage(opened.sessionId, 'user', [{ type: 'text', text: `${PHRASE} please delegate this` }]);
    await runtime.runSession(opened.sessionId);

    assert.ok(childViews.length > 0, 'child ran');
    assert.equal(childViews[0].text.includes(PHRASE), false);
    assert.equal(childViews[0].systemPrompt.includes(PHRASE), false);
    assert.match(childViews[0].text, /delegated task only/);
    const child = runtime.listSessions().find((item) => item.mode === 'subagent' && item.parentSessionId === opened.sessionId);
    assert.ok(child);
    assert.equal(child.agentId, 'researcher');
    const lookedUp = JSON.parse(
      (await tool(runtime, 'history_search').execute(ctx(runtime, runtime.getSession(child.id)), { query: PHRASE })).content
    );
    const hit = lookedUp.matches.find((item) => item.sessionId === opened.sessionId && item.excerpt.includes(PHRASE));
    assert.ok(hit, 'parent sentence and its source should be returned');
    const page = JSON.parse(
      (await tool(runtime, 'history_read').execute(ctx(runtime, runtime.getSession(child.id)), { ref: hit.ref })).content
    );
    assert.match(page.text, new RegExp(PHRASE));
    const parentResult = runtime
      .getSessionMessages(opened.sessionId)
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_result' && part.name === 'spawn_subagent');
    assert.ok(parentResult);
    assert.match(parentResult.content, /child-final-summary/);
    assert.equal(parentResult.content.includes(PHRASE), false);
    assert.equal(parentResult.content.includes('history:'), false);
    assert.equal(parentResult.content.includes('child-final-summary'), true);
  } finally {
    await runtime.destroy();
  }
});

test('bot child lists and opens parent notes, durable memory, and team or project memory [AC:bot-fork-retrievable-inheritance#AC-2]', async () => {
  const runtime = idleRuntime();
  try {
    const bot = runtime.createBot({ name: 'Alpha', description: DUTY });
    const other = runtime.createBot({ name: 'Beta', description: OTHER_DUTY });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    const foreign = runtime.getSession(runtime.openBot(other.id).sessionId);
    const parentCtx = ctx(runtime, parent);
    const set = tool(runtime, 'memory_set');
    const scratch = fullText('PARENT_SCRATCH_TOKEN');
    const durable = fullText('PARENT_USER_TOKEN');
    const team = fullText('PARENT_TEAM_TOKEN');
    const project = fullText('PARENT_PROJECT_TOKEN');
    assert.equal((await set.execute(parentCtx, { scope: 'scratch', key: 'parent.note', value: scratch })).ok, true);
    assert.equal((await set.execute(parentCtx, { scope: 'long', key: 'parent.long', value: fullText('PARENT_LONG_TOKEN') })).ok, true);
    assert.equal((await set.execute(parentCtx, { scope: 'user', key: 'parent.user', value: durable })).ok, true);
    assert.equal((await set.execute(parentCtx, { scope: 'team', key: 'parent.team', value: team })).ok, true);
    assert.equal((await set.execute(parentCtx, { scope: 'project', key: 'parent.project', value: project })).ok, true);
    assert.equal(
      (await set.execute(ctx(runtime, foreign), { scope: 'user', key: 'beta.user', value: fullText('BETA_PRIVATE_TOKEN') })).ok,
      true
    );
    runtime.store.agentMemory().set({
      scope: 'user.memory',
      namespace: 'default',
      key: 'other-user',
      value: fullText('OTHER_USER_TOKEN'),
      userId: 'someone-else',
      agentId: bot.agentId,
      importance: 0.9,
      confidence: 'high',
      source: 'user_provided'
    });
    runtime.store.agentMemory().set({
      scope: 'team.memory',
      namespace: 'default',
      key: 'shared-pool',
      value: fullText('SHARED_POOL_TOKEN'),
      userId: parent.metadata.userId,
      importance: 0.9,
      confidence: 'high',
      source: 'user_provided'
    });
    appendWorkingLogEntry(workingLogPath(runtime.stateDir, parent.id), {
      kind: 'step_outcome',
      content: fullText('PARENT_LOG_TOKEN')
    });
    const child = childOf(runtime, parent);
    const sibling = runtime.store.createSession({
      title: 'sibling',
      mode: 'subagent',
      agentId: 'researcher',
      parentSessionId: parent.id,
      metadata: {
        botId: parent.metadata.botId,
        parentSessionId: parent.id,
        userId: parent.metadata.userId,
        tenantId: parent.metadata.tenantId
      }
    });
    appendWorkingLogEntry(workingLogPath(runtime.stateDir, sibling.id), {
      kind: 'step_outcome',
      content: fullText('SIBLING_LOG_TOKEN')
    });
    const childCtx = ctx(runtime, runtime.getSession(child.id));
    const get = tool(runtime, 'memory_get');
    const search = tool(runtime, 'memory_search');
    const read = tool(runtime, 'memory_read');

    for (const [scope, token] of [
      ['scratch', 'PARENT_SCRATCH_TOKEN'],
      ['long', 'PARENT_LONG_TOKEN'],
      ['user', 'PARENT_USER_TOKEN'],
      ['team', 'PARENT_TEAM_TOKEN'],
      ['project', 'PARENT_PROJECT_TOKEN']
    ]) {
      const listed = await get.execute(childCtx, { scope });
      assert.match(listed.content, new RegExp(token), scope);
      assert.match(listed.content, new RegExp(`END_${token}`), `${scope} full value`);
      const found = JSON.parse((await search.execute(childCtx, { query: token, scope })).content);
      assert.ok(found.matches.some((item) => item.key.includes('parent') || item.excerpt.includes(token)), scope);
      assert.equal(found.matches.some((item) => item.excerpt.includes(`END_${token}`)), false, `${scope} search stays an excerpt`);
      const ref = found.matches.find((item) => item.excerpt.includes(token)).ref;
      const page = JSON.parse((await read.execute(childCtx, { ref })).content);
      assert.match(page.text, new RegExp(`END_${token}`), `${scope} read is the full value`);
    }

    const log = JSON.parse((await search.execute(childCtx, { query: 'PARENT_LOG_TOKEN' })).content);
    assert.ok(log.matches.some((item) => item.excerpt.includes('PARENT_LOG_TOKEN')));
    const logPage = JSON.parse(
      (await read.execute(childCtx, { ref: log.matches.find((item) => item.excerpt.includes('PARENT_LOG_TOKEN')).ref })).content
    );
    assert.match(logPage.text, /END_PARENT_LOG_TOKEN/);
    const appendix = compileTurnAppendix({
      session: runtime.getSession(child.id),
      query: 'PARENT_LOG_TOKEN',
      store: runtime.store,
      stateDir: runtime.stateDir
    });
    assert.equal(appendix.includes('PARENT_LOG_TOKEN'), false);

    for (const token of ['BETA_PRIVATE_TOKEN', 'OTHER_USER_TOKEN', 'SHARED_POOL_TOKEN', 'SIBLING_LOG_TOKEN']) {
      const missed = JSON.parse((await search.execute(childCtx, { query: token })).content);
      assert.equal(missed.notice, EMPTY, token);
      assert.equal(JSON.stringify(missed).includes(token), false, token);
      assert.equal(JSON.stringify(missed).includes(`END_${token}`), false, token);
    }
    const listedUser = await get.execute(childCtx, { scope: 'user' });
    assert.equal(listedUser.content.includes('BETA_PRIVATE_TOKEN'), false);
    assert.equal(listedUser.content.includes('OTHER_USER_TOKEN'), false);
    assert.equal(listedUser.content.includes('SHARED_POOL_TOKEN'), false);

    const bareParent = runtime.store.createSession({
      title: 'bare',
      mode: 'chat',
      agentId: bot.agentId,
      metadata: { botId: bot.id }
    });
    const bareLong = fullText('OWNERLESS_LONG_TOKEN');
    runtime.store.upsertSessionMemory({ sessionId: bareParent.id, scope: 'long', key: 'legacy.long', value: bareLong });
    runtime.store.agentMemory().set({
      scope: 'project.memory',
      namespace: 'default',
      key: 'legacy.project',
      value: fullText('OWNERLESS_PROJECT_TOKEN'),
      agentId: bot.agentId,
      sessionId: bareParent.id,
      importance: 0.6,
      confidence: 'medium',
      source: 'user_provided'
    });
    const bareChild = runtime.store.createSession({
      title: 'bare-child',
      mode: 'subagent',
      agentId: 'researcher',
      parentSessionId: bareParent.id,
      metadata: { botId: bot.id, parentSessionId: bareParent.id }
    });
    const bareCtx = ctx(runtime, runtime.getSession(bareChild.id));
    assert.match((await get.execute(bareCtx, { scope: 'long' })).content, /END_OWNERLESS_LONG_TOKEN/);
    const bareProject = JSON.parse((await search.execute(bareCtx, { query: 'OWNERLESS_PROJECT_TOKEN', scope: 'project' })).content);
    const barePage = JSON.parse((await read.execute(bareCtx, { ref: bareProject.matches[0].ref })).content);
    assert.match(barePage.text, /END_OWNERLESS_PROJECT_TOKEN/);
    const bareMiss = JSON.parse((await search.execute(bareCtx, { query: 'OTHER_USER_TOKEN' })).content);
    assert.equal(bareMiss.notice, EMPTY);
    assert.equal(JSON.stringify(bareMiss).includes('OTHER_USER_TOKEN'), false);
  } finally {
    await runtime.destroy();
  }
});

test('research child can read its bot name and duties without taking another bot [AC:bot-fork-retrievable-inheritance#AC-5]', async () => {
  const runtime = idleRuntime();
  try {
    const bot = runtime.createBot({ name: 'Qinglan', description: DUTY });
    const other = runtime.createBot({ name: 'Otherbot', description: OTHER_DUTY });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    runtime.store.appendMessage(parent.id, 'user', [{ type: 'text', text: PHRASE }]);
    const child = childOf(runtime, parent);
    runtime.store.appendMessage(child.id, 'user', [{ type: 'text', text: 'delegated task only' }]);
    const childSession = runtime.getSession(child.id);
    const read = await tool(runtime, 'history_read').execute(ctx(runtime, childSession), { ref: 'bot:self' });
    assert.equal(read.ok, true);
    const body = JSON.parse(read.content);
    assert.equal(body.name, 'Qinglan');
    assert.match(body.duties, new RegExp(DUTY));
    assert.equal(read.content.includes(PHRASE), false);
    assert.equal(read.content.includes(OTHER_DUTY), false);
    const refused = await tool(runtime, 'history_read').execute(ctx(runtime, childSession), { ref: `bot:${other.id}` });
    assert.equal(refused.ok, false);
    assert.equal(refused.content.includes(OTHER_DUTY), false);
    assert.equal(refused.content.includes('Otherbot'), false);
    const after = runtime.getSession(child.id);
    assert.equal(after.agentId, 'researcher');
    assert.equal(after.metadata.botId, bot.id);
    const researcher = runtime.store.getAgent('researcher');
    const prefix = new PromptBuilder({ store: runtime.store, repoRoot: runtime.repoRoot, stateDir: runtime.stateDir }).buildStablePrefix({
      agent: researcher,
      session: after,
      repoRoot: runtime.repoRoot
    });
    assert.equal(prefix.includes(DUTY), false);
    assert.equal(prefix.includes(PHRASE), false);
    assert.equal(JSON.stringify(runtime.getSessionMessages(child.id)).includes(PHRASE), false);
    const appendix = compileTurnAppendix({
      session: after,
      query: 'delegated task only',
      store: runtime.store,
      stateDir: runtime.stateDir
    });
    assert.equal(appendix.includes(PHRASE), false);
    assert.equal(appendix.includes(DUTY), false);
  } finally {
    await runtime.destroy();
  }
});

test('sibling dialogue stays unreadable while parent notes stay searchable [AC:bot-fork-retrievable-inheritance#AC-6]', async () => {
  const runtime = idleRuntime();
  try {
    const bot = runtime.createBot({ name: 'Family', description: DUTY });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    const siblingPhrase = 'SIBLING_PRIVATE_DIALOGUE_22';
    runtime.store.upsertSessionMemory({ sessionId: parent.id, scope: 'scratch', key: 'parent.note', value: 'PARENT_NOTE_TOKEN' });
    runtime.store.appendMessage(parent.id, 'user', [{ type: 'text', text: 'parent harbor note' }]);
    const child = childOf(runtime, parent);
    const sibling = childOf(runtime, parent);
    runtime.store.appendMessage(sibling.id, 'user', [{ type: 'text', text: siblingPhrase }]);
    const childCtx = ctx(runtime, runtime.getSession(child.id));
    const missed = JSON.parse(
      (await tool(runtime, 'history_search').execute(childCtx, { query: siblingPhrase })).content
    );
    assert.equal(missed.notice, EMPTY);
    assert.equal(JSON.stringify(missed).includes(siblingPhrase), false);
    const siblingMessage = runtime.store.foldMessages(sibling.id).find((message) => message.role === 'user');
    assert.equal(
      (await tool(runtime, 'history_read').execute(childCtx, { ref: `history:${sibling.id}:${siblingMessage.id}:0` })).ok,
      false
    );
    assert.equal(
      (await tool(runtime, 'history_read').execute(childCtx, { session_id: sibling.id, seq: siblingMessage.seq })).ok,
      false
    );
    const help = await tool(runtime, 'ask_bot_help').execute(childCtx, { message: 'need a hand with the step', audience: 'siblings' });
    assert.equal(help.ok, true);
    assert.equal(help.content.includes(siblingPhrase), false);
    const delivered = runtime.store.foldMessages(sibling.id).flatMap((message) => message.parts.map((part) => part.text ?? part.content ?? ''));
    assert.ok(delivered.some((text) => text.includes('need a hand with the step')));
    assert.equal(delivered.filter((text) => text.includes(siblingPhrase)).length, 1);
    const notes = JSON.parse((await tool(runtime, 'memory_search').execute(childCtx, { query: 'PARENT_NOTE_TOKEN', scope: 'scratch' })).content);
    assert.ok(notes.matches.some((item) => item.excerpt.includes('PARENT_NOTE_TOKEN')));
  } finally {
    await runtime.destroy();
  }
});

test('a miss stays empty and does not borrow another bot [AC:bot-fork-retrievable-inheritance#AC-8]', async () => {
  const runtime = idleRuntime();
  try {
    const bot = runtime.createBot({ name: 'Alpha', description: DUTY });
    const other = runtime.createBot({ name: 'Beta', description: OTHER_DUTY });
    const parent = runtime.getSession(runtime.openBot(bot.id).sessionId);
    const foreign = runtime.getSession(runtime.openBot(other.id).sessionId);
    runtime.store.appendMessage(parent.id, 'user', [{ type: 'text', text: PHRASE }]);
    runtime.store.appendMessage(foreign.id, 'user', [{ type: 'text', text: 'MISSING_TOKEN_ZZ lives only on the other bot' }]);
    await tool(runtime, 'memory_set').execute(ctx(runtime, parent), {
      scope: 'user',
      key: 'unrelated',
      value: fullText('UNRELATED_PARENT_MEMORY')
    });
    await tool(runtime, 'memory_set').execute(ctx(runtime, foreign), {
      scope: 'user',
      key: 'foreign',
      value: fullText('MISSING_TOKEN_ZZ')
    });
    const child = childOf(runtime, parent);
    runtime.store.appendMessage(child.id, 'user', [{ type: 'text', text: 'delegated task only' }]);
    const childCtx = ctx(runtime, runtime.getSession(child.id));
    const history = JSON.parse((await tool(runtime, 'history_search').execute(childCtx, { query: 'MISSING_TOKEN_ZZ' })).content);
    const memory = JSON.parse((await tool(runtime, 'memory_search').execute(childCtx, { query: 'MISSING_TOKEN_ZZ' })).content);
    assert.equal(history.notice, EMPTY);
    assert.equal(memory.notice, EMPTY);
    for (const body of [history, memory]) {
      const text = JSON.stringify(body);
      assert.equal(text.includes('MISSING_TOKEN_ZZ'), false);
      assert.equal(text.includes('UNRELATED_PARENT_MEMORY'), false);
      assert.equal(text.includes(PHRASE), false);
      assert.equal(text.includes(OTHER_DUTY), false);
    }
    const appendix = compileTurnAppendix({
      session: runtime.getSession(child.id),
      query: 'MISSING_TOKEN_ZZ',
      store: runtime.store,
      stateDir: runtime.stateDir
    });
    assert.equal(appendix.includes(PHRASE), false);
    assert.equal(appendix.includes('MISSING_TOKEN_ZZ'), false);
    assert.equal(appendix.includes(DUTY), false);
    assert.equal(JSON.stringify(runtime.getSessionMessages(child.id)).includes(PHRASE), false);
  } finally {
    await runtime.destroy();
  }
});
