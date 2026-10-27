import test from 'node:test';
import assert from 'node:assert/strict';
import { composerRunSelection, savedSteerPolicy } from './loop-composer-defaults.ts';

const savedFast = {
  hasSession: false,
  touched: false,
  currentTaskMode: 'auto' as const,
  currentSkillScope: 'full' as const,
  currentEngine: 'legacy' as const,
  savedTaskMode: 'fast',
  savedSkillScope: 'requested'
};

test('新建对话采用已保存的任务模式和技能范围 [AC:conversation-loop-defaults#AC-1] [AC:conversation-loop-defaults#AC-2]', () => {
  assert.deepEqual(composerRunSelection(savedFast), {
    taskMode: 'fast',
    skillScope: 'requested',
    orchestrationEngine: 'legacy',
    deferred: false
  });
  assert.equal(
    composerRunSelection({ ...savedFast, savedTaskMode: 'dynamic_workflow' }).orchestrationEngine,
    'ptc'
  );
  assert.equal(savedSteerPolicy('steer'), 'steer');
});

test('已有对话保持自己的模式和技能范围 [AC:conversation-loop-defaults#AC-3]', () => {
  const kept = composerRunSelection({
    ...savedFast,
    hasSession: true,
    currentTaskMode: 'planner',
    currentSkillScope: 'full',
    currentEngine: 'legacy'
  });
  assert.equal(kept.taskMode, 'planner');
  assert.equal(kept.skillScope, 'full');
  const touched = composerRunSelection({
    ...savedFast,
    touched: true,
    currentTaskMode: 'browser',
    currentSkillScope: 'full'
  });
  assert.equal(touched.taskMode, 'browser');
  assert.equal(touched.skillScope, 'full');
  assert.equal(kept.deferred, false);
});

test('默认值还没读到时新对话不先写成自动 [AC:conversation-loop-defaults#AC-1]', () => {
  const pending = composerRunSelection({
    ...savedFast,
    savedTaskMode: undefined,
    savedSkillScope: undefined,
    settingsLoaded: false
  });
  assert.equal(pending.deferred, true);
});
