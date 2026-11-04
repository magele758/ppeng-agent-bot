import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { classifyGoalIntents } from '../dist/bots/goals/intake.js';
import { defaultTeamsDagSettings, normalizeTeamsDagSettings } from '../dist/teams/settings.js';
import { loadRuntimeEnvConfig } from '../dist/runtime-env.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-extreme-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = store.createSession({
    title: 'Bot', mode: 'chat', agentId: 'general',
    metadata: { canonicalBotChat: true, botId: 'b', permissionMode: 'ask', allowedTools: ['read_file', 'spawn_subagent'], userId: 'owner' }
  });
  const service = new BotGoalService(store, Date.now, parent.id);
  const runs = [];
  const running = new Set();
  const host = {
    store,
    deadSessions: new Set(),
    isRunning: id => running.has(id),
    cancel: id => { running.delete(id); },
    run: id => { runs.push(id); running.add(id); return new Promise(() => {}); },
    capabilities: () => ({ registeredTools: ['spawn_subagent', 'read_file'], enabledStrategies: ['direct', 'subagent'] }),
    executionInterrupted: id => host.deadSessions.has(id)
  };
  const create = (extra = {}) => service.create({ botId: 'b', sessionId: parent.id, title: '分析', objective: '分析这项工作', ...extra });
  return { service, host, create, runs };
}

const parallelList = [
  '请分多个 agent 并行完成下面这些工作。',
  '分析目标调度的并发上限。',
  '提高同时运行的目标数。',
  '把一句话里的多件工作拆开并行。',
  '补上并发验收。',
  '核对保存的较低上限仍然生效。',
  '放宽团队任务的并行人数。',
  '提高单轮里同时执行的工具数。',
  '让工作台能保存更高的并发。',
  '保留一件工作时不额外派生子代理。',
  '记下每个目标的结果。',
  '失败的目标单独重试。',
  '协调者仍是原来的对话。'
].join('\n');

test('twelve independent agent slices start together under the unsaved ceiling [AC:bot-extreme-concurrency#AC-1] [AC:bot-extreme-concurrency#AC-2]', async () => {
  const intents = await classifyGoalIntents(parallelList, []);
  const goals = intents.filter(intent => intent.kind === 'new_goal');
  assert.equal(goals.length, 12);
  assert.equal(intents.some(intent => intent.kind === 'chat' && /分多个 agent/.test(intent.text)), true);
});

test('sibling goals from one split run past the old cap of four [AC:bot-extreme-concurrency#AC-1]', async t => {
  const { service, host, create, runs } = fixture(t);
  assert.ok(service.readSettings().maxConcurrent > 4);
  create({ sourceMessageId: 'msg', title: '第一件', objective: '分析第一件' });
  for (let index = 1; index <= 11; index += 1) {
    create({ sourceMessageId: `msg:${index}`, resumeRequested: true, title: `第${index}件`, objective: `分析第${index}件` });
  }
  await tickBotGoals(host);
  assert.equal(runs.length, 11);
});

test('a saved concurrency of one still holds the rest [AC:bot-extreme-concurrency#AC-3]', async t => {
  const { service, host, create, runs } = fixture(t);
  service.updateSettings({ maxConcurrent: 1 });
  const first = create({ title: '甲', objective: '分析甲' });
  const second = create({ title: '乙', objective: '分析乙' });
  assert.ok(service.claim('b', first.id, { strategy: 'direct' }));
  assert.equal(service.claim('b', second.id, { strategy: 'direct' }), undefined);
  assert.match(service.get('b', second.id).blockedReason, /concurrency capacity/);
  create({ sourceMessageId: 'msg:extra', resumeRequested: true, title: '丙', objective: '分析丙' });
  await tickBotGoals(host);
  assert.equal(runs.length, 0);
});

test('team worker concurrency above 16 is kept [AC:bot-extreme-concurrency#AC-4]', () => {
  assert.ok(defaultTeamsDagSettings().maxConcurrent > 3);
  assert.equal(normalizeTeamsDagSettings({ maxConcurrent: 32 }).maxConcurrent, 32);
  assert.equal(normalizeTeamsDagSettings({ maxConcurrent: 999 }).maxConcurrent, 256);
});

test('unsaved tool parallelism is wide enough for a multi-agent turn', () => {
  assert.equal(loadRuntimeEnvConfig({}).maxParallelToolCalls, 32);
});
