import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseRepeatedLines } from './collapse-repeated-lines.ts';

test('相邻完全相同的正文行只留一行 [AC:assistant-repeat-collapse#AC-1]', () => {
  const line = '上次是 401，因为没带密钥。你给了内网密钥，我让三台用它再打一次。';
  assert.equal(collapseRepeatedLines(`${line}\n${line}\n\n下一句。\n下一句。`), `${line}\n\n下一句。`);
});

test('不相同的相邻行保留 [AC:assistant-repeat-collapse#AC-2]', () => {
  assert.equal(collapseRepeatedLines('第一句。\n第二句。'), '第一句。\n第二句。');
  assert.equal(collapseRepeatedLines('\n\n'), '\n\n');
});
