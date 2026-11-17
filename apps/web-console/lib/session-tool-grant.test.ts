import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from './i18n/t.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  approvalPostInit,
  grantsWithout,
  isolationClass,
  isolationLabel,
  isolationModeOf,
  readSessionToolGrants,
  sessionGrantRows,
} from './session-tool-grant.ts';

const t = (key: string) => translate(zh, key);

test('本会话允许只认同一工具和同一隔离，并带上保存请求 [AC:console-sections-redesign#AC-1] [AC:console-sections-redesign#AC-2] [AC:console-sections-redesign#AC-3]', () => {
  assert.equal(isolationModeOf('bash', {}), 'auto');
  assert.equal(isolationModeOf('bash', { isolation: 'os' }), 'os');
  assert.equal(isolationModeOf('bash', { isolation: 'direct' }), 'direct');
  assert.equal(isolationModeOf('write_file', { path: 'a' }), 'unspecified');
  assert.equal(isolationLabel('os', t), '系统沙箱');
  assert.equal(isolationLabel('direct', t), '直接执行');
  assert.equal(isolationLabel('custom', t), 'custom');
  assert.equal(isolationClass('direct'), 'console-iso console-iso--direct');
  assert.equal(isolationClass('os'), 'console-iso');
  const grants = [{ toolName: 'bash', isolation: 'os' }, { toolName: 'write_file', isolation: 'unspecified' }];
  assert.deepEqual(grantsWithout(grants, 'bash', 'os'), [{ toolName: 'write_file', isolation: 'unspecified' }]);
  assert.deepEqual(approvalPostInit(true).body, JSON.stringify({ sessionGrant: true }));
  assert.deepEqual(JSON.parse(approvalPostInit(false).body), {});
  const rows = sessionGrantRows([{ id: 's1', title: '研究', metadata: { sessionToolGrants: grants } }, { id: 's2', metadata: {} }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.remaining.length, 1);
  assert.deepEqual(readSessionToolGrants(null), []);
  assert.deepEqual(readSessionToolGrants({ sessionToolGrants: 'nope' }), []);
});
