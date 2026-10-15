import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCATION,
  SECTION_IDS,
  SUB_PAGES,
  canonicalOpsHash,
  formatHash,
  parseHash
} from './nav.ts';
import { parseRailCollapsed } from './rail-collapsed.ts';

test('空 hash 与非法 hash 回落到对话 [AC:console-navigation#AC-1]', () => {
  assert.deepEqual(parseHash(''), DEFAULT_LOCATION);
  assert.deepEqual(parseHash('#/nope'), DEFAULT_LOCATION);
  assert.deepEqual(parseHash('#/nope/ops'), DEFAULT_LOCATION);
});

test('一级导航为 Bot、对话、其余页，不含运维 [AC:console-navigation#AC-1]', () => {
  assert.deepEqual([...SECTION_IDS], ['bot', 'chat', 'agents', 'tasks', 'knowledge', 'settings']);
  assert.equal((SECTION_IDS as readonly string[]).includes('ops'), false);
  assert.equal(SUB_PAGES.settings.includes('ops'), true);
  assert.ok(SECTION_IDS.indexOf('bot') < SECTION_IDS.indexOf('chat'));
});

test('导航没有 Evolution 入口 [AC:ops-console#AC-9]', () => {
  assert.equal((SECTION_IDS as readonly string[]).includes('evolution'), false);
  for (const subs of Object.values(SUB_PAGES)) {
    assert.equal((subs as readonly string[]).includes('evolution'), false);
  }
});

test('hash 可解析为 section 与子页，往返一致 [AC:console-navigation#AC-2]', () => {
  assert.deepEqual(parseHash('#/settings/ops/health'), { section: 'settings', sub: 'ops', pane: 'health' });
  assert.equal(formatHash({ section: 'settings', sub: 'ops', pane: 'health' }), '#/settings/ops/health');
  assert.deepEqual(parseHash('#/bot'), { section: 'bot', sub: null, pane: null });
  assert.equal(formatHash({ section: 'bot', sub: null }), '#/bot');
  for (const section of SECTION_IDS) {
    for (const sub of SUB_PAGES[section]) {
      const pane = section === 'settings' && sub === 'ops' ? 'trajectory' : null;
      const loc = { section, sub, pane };
      assert.deepEqual(parseHash(formatHash(loc)), loc);
    }
  }
});

test('缺省或非法子页取该 section 的第一个子页 [AC:console-navigation#AC-2]', () => {
  assert.deepEqual(parseHash('#/settings'), { section: 'settings', sub: 'general', pane: null });
  assert.deepEqual(parseHash('#/tasks/bogus'), { section: 'tasks', sub: 'queue', pane: null });
  assert.deepEqual(parseHash('#/chat/whatever'), { section: 'chat', sub: null, pane: null });
});

test('旧运维地址落到设置中的同一页 [AC:console-navigation#AC-2] [AC:console-navigation#AC-3]', () => {
  assert.deepEqual(parseHash('#/ops'), { section: 'settings', sub: 'ops', pane: 'trajectory' });
  assert.deepEqual(parseHash('#/ops/health'), { section: 'settings', sub: 'ops', pane: 'health' });
  assert.deepEqual(parseHash('#/ops/trajectory'), { section: 'settings', sub: 'ops', pane: 'trajectory' });
  assert.equal(canonicalOpsHash('#/ops/health'), '#/settings/ops/health');
  assert.equal(canonicalOpsHash('#/ops'), '#/settings/ops/trajectory');
  assert.equal(canonicalOpsHash('#/settings/ops'), '#/settings/ops/trajectory');
  assert.equal(canonicalOpsHash('#/settings/ops/health'), null);
  assert.equal(canonicalOpsHash('#/chat'), null);
});

test('侧栏折叠偏好只认已保存的真值', () => {
  assert.equal(parseRailCollapsed(null), false);
  assert.equal(parseRailCollapsed(''), false);
  assert.equal(parseRailCollapsed('0'), false);
  assert.equal(parseRailCollapsed('1'), true);
  assert.equal(parseRailCollapsed('true'), true);
  assert.equal(parseRailCollapsed('false'), false);
});
