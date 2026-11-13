import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { evaluateMemoryWrite } from '../dist/memory/memory-gate.js';
import { findSimilarSemanticFact, identityTextOverlap, mergeSemanticFactContent } from '../dist/memory/memory-semantic-merge.js';
import { heuristicExtractDialogueFacts, shouldAttemptDialogueExtract } from '../dist/memory/memory-dialogue-extract.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { curateTaskEnd, publishTaskEndObservation } from '../dist/memory/memory-curator.js';
import { compileTurnAppendix } from '../dist/session/context-compiler.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import {
  defaultMemorySettings,
  readMemorySettings,
  writeMemorySettings
} from '../dist/memory/memory-settings.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-family-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

test('semantic merge prevents duplicate identity facts', () => {
  assert.equal(identityTextOverlap('用户姓名是张三，职业工程师', '我是张三，工程师'), true);
  const merged = mergeSemanticFactContent('用户姓名是张三', '用户姓名是张三，就职于 Acme');
  assert.ok(merged.includes('张三'));
  assert.ok(merged.includes('Acme'));
  const hit = findSimilarSemanticFact({
    content: '用户姓名是张三',
    category: 'fact',
    candidates: [{ id: '1', content: '用户叫张三，职业工程师', category: 'fact' }]
  });
  assert.ok(hit);
  assert.equal(hit.id, '1');
});

test('saveSemanticFact merges instead of duplicating', () => {
  const store = tmpStore();
  const am = store.agentMemory();
  const a = saveSemanticFact(am, {
    userId: 'u1',
    category: 'fact',
    content: '用户姓名是张三'
  });
  const b = saveSemanticFact(am, {
    userId: 'u1',
    category: 'fact',
    content: '用户是张三，职业工程师'
  });
  assert.ok(a && b);
  assert.equal(b.merged, true);
  assert.equal(a.id, b.id);
  const rows = am.search({ scope: 'user.memory', userId: 'u1', limit: 20 });
  const semantic = rows.filter((r) => r.namespace === 'semantic');
  assert.equal(semantic.length, 1);
  assert.ok(semantic[0].value.includes('张三'));
  store.db.close();
});

test('dialogue extract skips chitchat and catches identity', () => {
  assert.equal(shouldAttemptDialogueExtract('你好'), false);
  const facts = heuristicExtractDialogueFacts('请记住我叫张三，我是工程师');
  assert.ok(facts.length >= 1);
  assert.ok(facts.some((f) => f.content.includes('张三')));
});

test('curator observe_only does not write', async () => {
  const store = tmpStore();
  writeMemorySettings(store, { curatorMode: 'observe_only' });
  const am = store.agentMemory();
  const { obs, tailPromise } = publishTaskEndObservation(
    am,
    {
      sessionId: 's1',
      taskContent: '帮我把预发部署文档写完整并列出回滚步骤',
      outcome: 'success',
      toolsUsed: ['bash', 'read_file', 'grep'],
      userId: 'u1',
      rawSummary: '已经写好预发部署与回滚步骤，包含 migrate 顺序。'
    },
    { settingsStore: store }
  );
  assert.ok(obs);
  assert.equal(obs.gate, 'skipped');
  assert.equal(tailPromise, null);
  assert.equal(am.search({ scope: 'user.memory', userId: 'u1' }).length, 0);
  store.db.close();
});

test('memory settings persist in daemon_control KV', () => {
  const store = tmpStore();
  assert.equal(readMemorySettings(store).curatorMode, defaultMemorySettings().curatorMode);
  const saved = writeMemorySettings(store, { curatorMode: 'off', compilerEnabled: false, embeddingRecall: true });
  assert.equal(saved.curatorMode, 'off');
  assert.equal(readMemorySettings(store).compilerEnabled, false);
  assert.equal(readMemorySettings(store).embeddingRecall, true);
  assert.equal(defaultMemorySettings().embeddingRecall, false);
  store.db.close();
});

test('user profile is stored independently and compiled as first slot', () => {
  const store = tmpStore();
  const am = store.agentMemory();
  am.upsertUserProfile({
    userId: 'u1',
    displayName: 'Ada',
    bio: '平台工程师',
    facts: ['负责支付网关'],
    preferences: ['中文简洁回复']
  });
  const session = {
        id: 'sess-p',
        title: 'p',
        mode: 'chat',
        status: 'idle',
        agentId: 'general',
        background: false,
        todo: [],
        metadata: { userId: 'u1' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
  const appendix = compileTurnAppendix({
    session,
    query: '支付',
    store
  });
  assert.ok(appendix.includes('Ada'));
  assert.ok(appendix.includes('用户画像'));
  store.db.close();
});

test('prompt-builder keeps memory out of system and in user appendix', async () => {
  const store = tmpStore();
  store.upsertSessionMemory({
    sessionId: 'sess-1',
    scope: 'scratch',
    key: 'plan',
    value: 'step 1 deploy preview'
  });
  const pb = new PromptBuilder({ store, repoRoot: '/repo' });
  const ctx = {
    agent: { id: 'test', name: 'Bot', role: 'assistant', instructions: 'Be helpful.', capabilities: [] },
    session: {
      id: 'sess-1',
      mode: 'chat',
      todo: [],
      summary: '',
      metadata: {},
      title: 't',
      status: 'idle',
      agentId: 'test',
      background: false,
      createdAt: '',
      updatedAt: ''
    },
    repoRoot: '/repo'
  };
  const dynamic = await pb.buildDynamicContext(ctx, []);
  assert.ok(!dynamic.includes('本轮相关记忆'));
  assert.ok(!dynamic.includes('[memory appendix]'));
  const sys = await pb.buildSystemPrompt(ctx, []);
  assert.ok(!sys.includes('本轮相关记忆'));
  const appendix = pb.buildMemoryAppendix(ctx, { query: 'deploy' });
  assert.ok(appendix.includes('plan'));
  store.db.close();
});

test('evaluateMemoryWrite is the memory_set gate', () => {
  assert.equal(evaluateMemoryWrite({ value: 'hi', kind: 'scratch' }).allow, false);
});

test('curateTaskEnd rejects chitchat and accepts deep task', async () => {
  const store = tmpStore();
  const am = store.agentMemory();
  const chitchat = am.insertObservation({
    kind: 'task_end',
    sessionId: 's-chat',
    taskContent: '你好',
    outcome: 'success',
    toolsUsed: ['bash', 'read_file', 'grep'],
    userId: 'u1',
    gate: 'pending'
  });
  await curateTaskEnd(am, chitchat, { minTaskTools: 3 });
  assert.equal(am.getObservation(chitchat.id)?.gate, 'rejected');

  const deepTask =
    '帮我把预发部署文档写完整并列出回滚步骤以及验收清单，覆盖 migrate 顺序。';
  const deep = am.insertObservation({
    kind: 'task_end',
    sessionId: 's-deep',
    taskContent: deepTask,
    outcome: 'success',
    toolsUsed: ['bash', 'read_file', 'grep'],
    userId: 'u1',
    rawSummary: deepTask,
    gate: 'pending'
  });
  const written = await curateTaskEnd(am, deep, { minTaskTools: 3 });
  assert.ok(written);
  const accepted = am.getObservation(deep.id);
  assert.equal(accepted?.gate, 'accepted');
  const rows = am.search({ scope: 'user.memory', userId: 'u1', limit: 20 });
  assert.ok(rows.some((r) => r.namespace === 'episodic' && r.value.includes('预发')));
  store.db.close();
});

test('deployment and tool chatter are not biographical evidence [AC:dialogue-identity-evidence#AC-1]', async () => {
  for (const input of ['我是内网部署的，不会泄漏到外部的','确认技能名字，不要重启已在跑的服务。','叫工具在本会话等确认']) {
    assert.deepEqual(heuristicExtractDialogueFacts(input), []);
  }
  const { extractDialogueFacts } = await import('../dist/memory/memory-dialogue-extract.js');
  assert.deepEqual(await extractDialogueFacts({userText:'我叫张三',completeText:async()=>'{"facts":[]}'}),[]);
  assert.deepEqual(heuristicExtractDialogueFacts('请记住我叫张三，我是软件工程师').filter(f=>f.category==='fact').map(f=>f.content),['用户姓名是张三','用户职业/身份：软件工程师']);
});
