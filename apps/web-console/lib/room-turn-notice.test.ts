import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { getMessage } from './i18n/t.ts';
import { roomTurnNoticeKey } from './room-turn-notice.ts';

function notice(turn: Parameters<typeof roomTurnNoticeKey>[0]) {
  const key = roomTurnNoticeKey(turn);
  assert.ok(key, 'a notice is expected');
  const texts = { zh: getMessage(zh, key), en: getMessage(en, key) };
  assert.ok(texts.zh && texts.en, `${key} needs zh and en text`);
  return { key, zh: texts.zh, en: texts.en };
}

test('费用预算停下的一轮，提示说的是费用预算和群设置，不提成员模型 [AC:group-budget-stop-notice#AC-1]', () => {
  const shown = notice({ status: 'failed', terminationReason: 'cost_budget' });
  assert.match(shown.zh, /费用预算/);
  assert.match(shown.zh, /群设置/);
  assert.doesNotMatch(shown.zh, /模型/);
  assert.match(shown.en, /cost budget/i);
  assert.match(shown.en, /group settings/i);
  assert.doesNotMatch(shown.en, /model/i);
});

test('工具调用上限停下的一轮，提示说的是工具调用上限和群设置，不提成员模型 [AC:group-budget-stop-notice#AC-2]', () => {
  const shown = notice({ status: 'failed', terminationReason: 'tool_budget' });
  assert.match(shown.zh, /工具调用上限/);
  assert.match(shown.zh, /群设置/);
  assert.doesNotMatch(shown.zh, /模型/);
  assert.match(shown.en, /tool call limit/i);
  assert.match(shown.en, /group settings/i);
  assert.doesNotMatch(shown.en, /model/i);
});

test('成员自己执行失败的一轮，仍是原来那条回复失败提示 [AC:group-budget-stop-notice#AC-3]', () => {
  for (const terminationReason of ['member_execution_failed', 'upstream exploded', undefined]) {
    assert.equal(roomTurnNoticeKey({ status: 'failed', terminationReason }), 'play.group.replyFailed');
  }
  assert.match(getMessage(zh, 'play.group.replyFailed') ?? '', /群成员本次回复失败/);
});

test('没有失败的一轮不出提示，即使结束原因写着预算 [AC:group-budget-stop-notice#AC-4]', () => {
  assert.equal(roomTurnNoticeKey(undefined), null);
  for (const status of ['completed', 'running', 'queued', 'waiting_approval', 'cancelled', 'unknown']) {
    assert.equal(roomTurnNoticeKey({ status, terminationReason: 'cost_budget' }), null);
  }
});
