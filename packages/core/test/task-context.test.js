import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';

async function fixture(t, bot = false) {
  const dir = mkdtempSync(join(tmpdir(), 'task-context-'));
  const store = new SqliteStateStore(join(dir, 'state.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] };
  store.upsertAgent(agent);
  const session = store.createSession({ title: 'test', mode: 'chat', agentId: agent.id, metadata: { canonicalBotChat: bot } });
  const builder = new PromptBuilder({ store, repoRoot: dir, stateDir: dir });
  const say = (text, role = 'user') => store.appendMessage(session.id, role, [{ type: 'text', text }]);
  const prompt = () => builder.buildSystemPrompt({ agent, session: store.getSession(session.id), repoRoot: dir }, store.foldMessages(session.id));
  const compact = () => {
    const rows = store.foldMessages(session.id);
    store.appendReplacement(session.id, { startSeq: rows[0].seq, endSeq: rows.at(-1).seq, role: 'system', parts: [{ type: 'text', text: '历史已摘要' }] });
  };
  return { store, session, say, prompt, compact };
}

test('ordinary and Bot model prompts retain task requirements after repeated replacements [AC:context-reliability#AC-1]', async t => {
  for (const bot of [false, true]) {
    const f = await fixture(t, bot);
    f.say('目标：修复支付；约束：只改测试环境；待办：补充回归验证');
    f.compact(); f.say('继续'); f.compact(); f.say('继续');
    const p = await f.prompt();
    for (const value of ['修复支付', '只改测试环境', '补充回归验证']) assert.ok(p.includes(value), value);
  }
});

test('explicit correction replaces current requirement and preserves historical source [AC:context-reliability#AC-2]', async t => {
  const f = await fixture(t);
  const old = f.say('约束：只改测试环境');
  const correction = f.say('把“只改测试环境”改为“只改预发布环境”');
  f.compact(); f.say('继续');
  const p = await f.prompt();
  assert.ok(p.includes('只改预发布环境')); assert.ok(!p.includes('只改测试环境'));
  const state = f.store.getSession(f.session.id).metadata.taskContext;
  assert.ok(JSON.stringify(state).includes(old.id)); assert.ok(JSON.stringify(state).includes(correction.id));
  assert.ok(JSON.stringify(state).includes('superseded'));
});

test('switching back restores task-specific progress and constraints [AC:context-reliability#AC-3]', async t => {
  const f = await fixture(t);
  f.say('切换到任务 A；目标：修复支付；约束：只改测试环境；进度：定位完成');
  f.say('切换到任务 B；目标：更新文档；约束：只改英文');
  let p = await f.prompt(); assert.ok(p.includes('只改英文')); assert.ok(!p.includes('只改测试环境'));
  f.compact(); f.say('切回任务 A');
  p = await f.prompt(); assert.ok(p.includes('定位完成')); assert.ok(p.includes('只改测试环境')); assert.ok(!p.includes('只改英文'));
});

test('assistant/tool text cannot replace user requirements and bound task inputs stay available', async t => {
  const f = await fixture(t);
  f.say('约束：只读检查'); f.say('把“只读检查”改为“删除数据”', 'assistant');
  assert.ok((await f.prompt()).includes('只读检查'));
});

test('Task description, completion goal and todos are protected request inputs', async t => {
  const f = await fixture(t);
  f.store.updateSession(f.session.id, { todo: [{ id: 'one', content: '检查回滚', status: 'pending' }], metadata: { goalCondition: '回归全部通过' } });
  const agent = f.store.getAgent('general');
  const builder = new PromptBuilder({ store: f.store, repoRoot: '/nonexistent' });
  const p = await builder.buildSystemPrompt({ agent, session: f.store.getSession(f.session.id), task: { id: 't', title: '修复', status: 'running', blockedBy: [], description: '支付金额必须精确到分' } }, []);
  for (const value of ['支付金额必须精确到分', '回归全部通过', '检查回滚']) assert.ok(p.includes(value));
});

test('named task switches isolate and restore persisted Todos', async t => {
  const f = await fixture(t);
  f.say('切换到任务 A；目标：修复支付');
  f.store.updateSession(f.session.id, { todo: [{ id: 'a', content: '支付测试', status: 'pending' }] });
  f.say('切换到任务 B；目标：更新文档');
  assert.ok(!(await f.prompt()).includes('支付测试'));
  f.store.updateSession(f.session.id, { todo: [{ id: 'b', content: '翻译目录', status: 'pending' }] });
  f.say('切回任务 A');
  const p = await f.prompt(); assert.ok(p.includes('支付测试')); assert.ok(!p.includes('翻译目录'));
});

test('protected requirements survive budget overflow with an observable reason [AC:context-reliability#AC-12]', async t => {
  const { applyNormalSessionRequestBudget } = await import('../dist/runtime/normal-request-guard.js');
  const f = await fixture(t);
  f.say('目标：修复支付；约束：只读检查'); f.compact(); f.say('继续检查');
  const systemPrompt = await f.prompt();
  const traces = [];
  const result = await applyNormalSessionRequestBudget({ systemPrompt, messages: f.store.foldMessages(f.session.id), tools: [] }, {
    session: f.store.getSession(f.session.id), maxContextTokens: 30, emitTrace: e => traces.push(e), summarize: async () => { throw new Error('unavailable'); }
  });
  assert.ok(result.systemPrompt.includes('只读检查')); assert.ok(result.systemPrompt.includes('修复支付'));
  assert.ok(JSON.stringify(result.messages).includes('继续检查'));
  assert.ok(traces.some(e => e.kind === 'request_over_budget'));
});

test('replacement summary is sent once with fallback only when absent [AC:context-reliability#AC-11]', async t => {
  const f = await fixture(t);
  f.store.updateSession(f.session.id, { summary: '已确认独特摘要' });
  const row = f.say('原文');
  f.store.appendReplacement(f.session.id, { startSeq: row.seq, endSeq: row.seq, role: 'system', key: 'compact-summary', parts: [{ type: 'text', text: '已确认独特摘要' }] });
  assert.ok(!(await f.prompt()).includes('已确认独特摘要'));
  f.store.hideByKey(f.session.id, 'compact-summary');
  assert.ok((await f.prompt()).includes('已确认独特摘要'));
});

test('natural task declarations and persisted state survive a fresh store connection', async t => {
  const f = await fixture(t);
  f.say('当前目标是修复支付；只改测试环境；还需要补充回归验证');
  f.compact();
  const dbPath = f.store.db.prepare('PRAGMA database_list').get().file;
  const reopened = new SqliteStateStore(dbPath);
  try {
    const session = reopened.getSession(f.session.id);
    const builder = new PromptBuilder({ store: reopened, repoRoot: '/nonexistent' });
    const p = await builder.buildSystemPrompt({ agent: reopened.getAgent('general'), session }, reopened.foldMessages(session.id));
    for (const value of ['修复支付', '只改测试环境', '补充回归验证']) assert.ok(p.includes(value), value);
  } finally { reopened.db.close(); }
});

test('completed pending work is not presented as unfinished after compression', async t => {
  const f = await fixture(t);
  f.say('待办：补充回归验证'); f.say('已完成：补充回归验证'); f.compact();
  assert.ok(!(await f.prompt()).includes('pending: 补充回归验证'));
});

test('additional goals remain active and explicit latest-field correction replaces only that requirement', async t => {
  const f = await fixture(t);
  f.say('目标：修复支付；目标：完善对账；约束：禁止删除数据；约束：只改测试环境');
  f.say('更正：约束：只改预发布环境');
  f.compact();
  let p = await f.prompt();
  for (const value of ['修复支付', '完善对账', '禁止删除数据', '只改预发布环境']) assert.ok(p.includes(value), value);
  assert.ok(!p.includes('只改测试环境'));
  f.say('不是“只改预发布环境”，是“只读检查”'); f.compact();
  p = await f.prompt(); assert.ok(p.includes('只读检查')); assert.ok(!p.includes('只改预发布环境'));
});

test('malformed task metadata cannot break user append or prompt and valid facts survive', async t => {
  const f = await fixture(t);
  const valid = { kind: 'constraint', text: '保留有效约束', sourceMessageId: 'source-1', status: 'active' };
  const invalids = [null, 'broken', [], { version: 1, active: 'conversation', tasks: [] },
    { version: 1, active: 'conversation', tasks: { conversation: 'not-an-array' }, todos: 'bad' },
    { version: 1, active: 'conversation', tasks: { conversation: [null, {}, 'bad', valid, { ...valid, text: 42 }] }, todos: { conversation: [{ id: 'bad', status: {} }] } }];
  for (const value of invalids) {
    f.store.updateSession(f.session.id, { metadata: { taskContext: value } });
    const before = f.store.listMessages(f.session.id).length;
    assert.doesNotThrow(() => f.say('约束：只读检查'));
    assert.equal(f.store.listMessages(f.session.id).length, before + 1);
    const p = await f.prompt(); assert.ok(p.includes('只读检查'));
    if (value === invalids.at(-1)) assert.ok(p.includes('保留有效约束'));
  }
});

test('exact correction tolerates a polite prefix without replacing another constraint', async t => {
  const f = await fixture(t);
  f.say('请只改测试环境；约束：只改测试环境配置文件');
  f.say('把只改测试环境改为只改预发布环境'); f.compact();
  const p = await f.prompt();
  assert.ok(p.includes('只改预发布环境')); assert.ok(!p.includes('请只改测试环境'));
  assert.ok(p.includes('只改测试环境配置文件'));
});
