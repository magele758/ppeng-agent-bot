import assert from 'node:assert/strict';
import test from 'node:test';
import { commitRoutineEnabled, presentMemoryValue } from './bot-detail-menu.ts';

test('开启后再关闭，定时任务状态跟着变 [AC:bot-detail-menu#AC-3]', async () => {
  const turnedOn = await commitRoutineEnabled(
    [{ id: 'morning', enabled: false }],
    'morning',
    true,
    async () => ({ enabled: true })
  );
  assert.equal(turnedOn.applied, true);
  assert.equal(turnedOn.jobs[0]?.enabled, true);

  const turnedOff = await commitRoutineEnabled(turnedOn.jobs, 'morning', false, async () => ({ enabled: false }));
  assert.equal(turnedOff.applied, true);
  assert.equal(turnedOff.jobs[0]?.enabled, false);
});

test('保存失败或服务端没有改状态时，不假装已经切换 [AC:bot-detail-menu#AC-4]', async () => {
  const jobs = [{ id: 'morning', enabled: true }];
  const rejected = await commitRoutineEnabled(jobs, 'morning', false, async () => {
    throw new Error('save failed');
  });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.jobs[0]?.enabled, true);
  assert.deepEqual(rejected.jobs, jobs);

  const ignored = await commitRoutineEnabled(jobs, 'morning', false, async () => ({ enabled: true }));
  assert.equal(ignored.applied, false);
  assert.equal(ignored.jobs[0]?.enabled, true);
});

test('记忆值里的 token 原文会被换成占位 [AC:bot-detail-menu#AC-1]', () => {
  const hidden = '已隐藏敏感内容';
  assert.equal(presentMemoryValue('api_key', 'sk-live-secret-token', hidden), hidden);
  assert.equal(presentMemoryValue('note', 'Bearer sk-live-secret-token', hidden).includes('sk-live'), false);
  assert.equal(presentMemoryValue('city', '杭州', hidden), '杭州');
});
