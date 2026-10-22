import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGhostKey,
  emptyGhost,
  ghostFromSuggestion,
  ghostText,
  suggestionStillCurrent,
  tabAcceptsGhost
} from './input-suggestion.ts';

test('空输入框显示淡色建议，Tab 写入真实输入后仍可编辑 [AC:bot-input-suggestion#AC-1]', () => {
  const ghost = ghostFromSuggestion({
    primary: '把失败日志再贴一次',
    alternatives: ['换成查数据库']
  });
  assert.equal(ghostText(ghost), '把失败日志再贴一次');
  assert.equal(ghostText(emptyGhost()), '');

  const accepted = applyGhostKey(ghost, 'Tab', '');
  assert.equal(accepted.preventDefault, true);
  assert.equal(accepted.commit, '把失败日志再贴一次');
  assert.equal(ghostText(accepted.state), '把失败日志再贴一次', '写入后仍记住当前条，便于再按 Tab 换备选');
  assert.equal(tabAcceptsGhost(accepted.state, accepted.commit ?? ''), true);

  const edited = `${accepted.commit ?? ''}，只要最近一小时`;
  assert.notEqual(edited, accepted.commit);
  const typedOver = applyGhostKey(ghost, 'type', '直');
  assert.equal(typedOver.commit, undefined);
  assert.equal(ghostText(typedOver.state), '', '直接打字时建议消失');
  assert.equal(tabAcceptsGhost(typedOver.state, '直'), false);
});

test('Tab 在多条建议间切换，Esc 与发送清空建议 [AC:bot-input-suggestion#AC-1] [AC:bot-input-suggestion#AC-3] [AC:bot-input-suggestion#AC-5]', () => {
  const ghost = ghostFromSuggestion({
    primary: '第一条',
    alternatives: ['第二条', '第三条', '第四条被丢掉']
  });
  assert.deepEqual(ghost.items, ['第一条', '第二条', '第三条']);

  const first = applyGhostKey(ghost, 'Tab', '');
  assert.equal(first.commit, '第一条');
  assert.equal(ghostText(first.state), '第一条', '第一次 Tab 写入真实输入，建议还在以便循环');
  const second = applyGhostKey(first.state, 'Tab', '第一条');
  assert.equal(second.commit, '第二条');
  assert.equal(second.preventDefault, true);
  const third = applyGhostKey(second.state, 'Tab', '第二条');
  assert.equal(third.commit, '第三条');

  const escaped = applyGhostKey(ghost, 'Escape', '');
  assert.equal(ghostText(escaped.state), '');
  assert.equal(escaped.preventDefault, true);
  assert.equal(escaped.commit, undefined, 'Esc 只撤销建议，不写入输入');

  const sent = applyGhostKey(ghost, 'send', '');
  assert.equal(ghostText(sent.state), '');
  const blurred = applyGhostKey(ghost, 'blur', '');
  assert.equal(ghostText(blurred.state), '');
});

test('新的建议请求覆盖旧请求，旧响应不能再显示 [AC:bot-input-suggestion#AC-4]', () => {
  const older = { requestId: 1, sessionId: 'bot-a' };
  const newer = { requestId: 2, sessionId: 'bot-a' };
  assert.equal(suggestionStillCurrent(older, newer), false);
  assert.equal(suggestionStillCurrent(newer, newer), true);
  assert.equal(suggestionStillCurrent(newer, { requestId: 2, sessionId: 'bot-b' }), false);
});
