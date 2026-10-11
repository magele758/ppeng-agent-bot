import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { parseBotChatCommand } from '../dist/bots/index.js';
import {
  readModelCatalog,
  resolveSessionModelAdapter,
  setCatalogDefaultRef,
  upsertProvider
} from '../dist/model/provider-catalog.js';

function makeRuntime(adapter) {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'bfc-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'bfc-state-')),
    modelAdapter: adapter ?? {
      name: 'stub',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'COMPACTED-SUMMARY';
      }
    }
  });
}

function seedTurns(store, sessionId, n = 3) {
  for (let i = 0; i < n; i += 1) {
    store.appendMessage(sessionId, 'user', [{ type: 'text', text: `question-${i}` }]);
    store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: `answer-${i}` }]);
  }
}

function userTexts(store, sessionId) {
  return store
    .listMessages(sessionId)
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text));
}

test('parseBotChatCommand only accepts the whole message', () => {
  assert.deepEqual(parseBotChatCommand('  /new  '), { command: 'new' });
  assert.deepEqual(parseBotChatCommand('/STOP'), { command: 'stop' });
  assert.deepEqual(parseBotChatCommand('/model beta-1'), { command: 'model', arg: 'beta-1' });
  assert.equal(parseBotChatCommand('/new please'), null);
  assert.equal(parseBotChatCommand('hello'), null);
  assert.equal(parseBotChatCommand(''), null);
});

test('Bot 固定对话里 /new 压缩同一条会话且不新开 [AC:bot-forever-chat#AC-1]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Keeper' });
  const sid = bot.canonicalSessionId;
  seedTurns(rt.store, sid);
  const idsBefore = rt.listSessions().map((session) => session.id);

  const result = await rt.handleBotChatCommand(sid, '/new');

  assert.equal(result?.code, 'compacted');
  assert.equal(result?.ok, true);
  assert.equal(result?.sessionId, sid);
  assert.deepEqual(
    rt.listSessions().map((session) => session.id).sort(),
    [...idsBefore].sort()
  );
  assert.equal(rt.getSession(sid).id, sid);
  assert.match(rt.getSession(sid).summary ?? '', /COMPACTED-SUMMARY/);
  assert.equal(userTexts(rt.store, sid).includes('/new'), false);
  assert.equal(rt.openBot(bot.id).sessionId, sid);
  assert.equal(rt.openBot(bot.id).createdSession, false);
});

test('正在生成时 /stop 停掉当前回合且不新开对话 [AC:bot-forever-chat#AC-2]', async () => {
  let entered;
  const enteredFlag = new Promise((resolve) => {
    entered = resolve;
  });
  const rt = makeRuntime({
    name: 'hang',
    async runTurn(input) {
      entered();
      await new Promise((resolve, reject) => {
        const signal = input?.signal;
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      });
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'late' }] };
    },
    async summarizeMessages() {
      return 'COMPACTED-SUMMARY';
    }
  });
  const bot = rt.createBot({ name: 'Stopper' });
  const sid = bot.canonicalSessionId;
  rt.store.appendMessage(sid, 'user', [{ type: 'text', text: 'keep going' }]);
  const idsBefore = rt.listSessions().map((session) => session.id);
  const run = rt.runSession(sid);
  await Promise.race([
    enteredFlag,
    new Promise((_, reject) => setTimeout(() => reject(new Error('turn did not start')), 8000))
  ]);

  const result = await rt.handleBotChatCommand(sid, '/stop');
  let runError;
  try {
    await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not finish the turn')), 8000))
    ]);
  } catch (error) {
    runError = error;
    if (runError instanceof Error && runError.message === 'stop did not finish the turn') throw runError;
  }

  assert.equal(result?.code, 'stopped');
  assert.equal(result?.ok, true);
  assert.equal(result?.sessionId, sid);
  assert.equal(rt.getSession(sid).metadata.outcome?.kind, 'aborted');
  assert.deepEqual(
    rt.listSessions().map((session) => session.id).sort(),
    [...idsBefore].sort()
  );
  assert.equal(userTexts(rt.store, sid).includes('/stop'), false);
});

test(' /model 切换、拒绝未知或重名，并能改回默认 [AC:bot-forever-chat#AC-3]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Picker' });
  const sid = bot.canonicalSessionId;
  upsertProvider(rt.store, {
    id: 'prov-a',
    name: 'Alpha',
    kind: 'openai-compatible',
    baseUrl: 'https://alpha.invalid/v1',
    apiKey: 'sk-a',
    models: [
      { id: 'alpha-1', enabled: true },
      { id: 'shared', enabled: true }
    ]
  });
  upsertProvider(rt.store, {
    id: 'prov-b',
    name: 'Beta',
    kind: 'anthropic-compatible',
    baseUrl: 'https://beta.invalid',
    apiKey: 'sk-b',
    models: [
      { id: 'beta-1', enabled: true },
      { id: 'shared', enabled: true }
    ]
  });
  setCatalogDefaultRef(rt.store, { providerId: 'prov-a', modelId: 'alpha-1' });
  assert.equal(rt.getSession(sid).metadata.modelOverride, undefined);

  const switched = await rt.handleBotChatCommand(sid, '/model beta-1');
  assert.equal(switched?.code, 'model_set');
  assert.equal(switched?.ok, true);
  assert.deepEqual(rt.getSession(sid).metadata.modelOverride, { providerId: 'prov-b', modelId: 'beta-1' });
  const adapted = resolveSessionModelAdapter(rt.store, rt.getSession(sid), {}, rt.modelAdapter);
  assert.equal(adapted.options?.model, 'beta-1');
  assert.equal(rt.listSessions().length, 1);

  const unknown = await rt.handleBotChatCommand(sid, '/model nope');
  assert.equal(unknown?.code, 'model_unknown');
  assert.equal(unknown?.ok, false);
  assert.deepEqual(rt.getSession(sid).metadata.modelOverride, { providerId: 'prov-b', modelId: 'beta-1' });

  const ambiguous = await rt.handleBotChatCommand(sid, '/model shared');
  assert.equal(ambiguous?.code, 'model_ambiguous');
  assert.equal(ambiguous?.ok, false);
  assert.deepEqual(rt.getSession(sid).metadata.modelOverride, { providerId: 'prov-b', modelId: 'beta-1' });

  const slash = await rt.handleBotChatCommand(sid, '/model prov-a/alpha-1');
  assert.equal(slash?.code, 'model_set');
  assert.deepEqual(rt.getSession(sid).metadata.modelOverride, { providerId: 'prov-a', modelId: 'alpha-1' });

  const cleared = await rt.handleBotChatCommand(sid, '/model default');
  assert.equal(cleared?.code, 'model_cleared');
  assert.equal(cleared?.ok, true);
  assert.equal(rt.getSession(sid).metadata.modelOverride, undefined);
  assert.equal(readModelCatalog(rt.store).defaultRef?.modelId, 'alpha-1');
  assert.equal(userTexts(rt.store, sid).some((text) => text.startsWith('/model')), false);
});

test('普通会话里的 /new 不是 Bot 命令 [AC:bot-forever-chat#AC-6]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Untouched' });
  seedTurns(rt.store, bot.canonicalSessionId);
  const plain = rt.createChatSession({ title: 'plain', message: 'hello', background: false });
  const beforeSummary = rt.getSession(bot.canonicalSessionId).summary;

  const result = await rt.handleBotChatCommand(plain.id, '/new');

  assert.equal(result, null);
  assert.equal(rt.getSession(bot.canonicalSessionId).summary, beforeSummary);
  assert.equal(rt.getSession(plain.id).id, plain.id);
});
