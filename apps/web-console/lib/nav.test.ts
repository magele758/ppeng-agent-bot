import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCATION, SECTION_IDS, SUB_PAGES, formatHash, parseHash } from './nav.ts';

test('空 hash 与非法 hash 回落到对话 [AC:console-navigation#AC-1]', () => {
  assert.deepEqual(parseHash(''), DEFAULT_LOCATION);
  assert.deepEqual(parseHash('#/nope'), DEFAULT_LOCATION);
  assert.deepEqual(parseHash('#/nope/ops'), DEFAULT_LOCATION);
});

test('一级导航恰好为六项 [AC:console-navigation#AC-1]', () => {
  assert.deepEqual([...SECTION_IDS], ['chat', 'agents', 'tasks', 'knowledge', 'ops', 'settings']);
});

test('导航没有 Evolution 入口 [AC:ops-console#AC-9]', () => {
  assert.equal((SECTION_IDS as readonly string[]).includes('evolution'), false);
  for (const subs of Object.values(SUB_PAGES)) {
    assert.equal((subs as readonly string[]).includes('evolution'), false);
  }
});

test('hash 可解析为 section 与子页，往返一致 [AC:console-navigation#AC-2]', () => {
  assert.deepEqual(parseHash('#/ops/health'), { section: 'ops', sub: 'health' });
  assert.equal(formatHash({ section: 'ops', sub: 'health' }), '#/ops/health');
  for (const section of SECTION_IDS) {
    for (const sub of SUB_PAGES[section]) {
      const loc = { section, sub };
      assert.deepEqual(parseHash(formatHash(loc)), loc);
    }
  }
});

test('缺省或非法子页取该 section 的第一个子页 [AC:console-navigation#AC-2]', () => {
  assert.deepEqual(parseHash('#/settings'), { section: 'settings', sub: 'general' });
  assert.deepEqual(parseHash('#/tasks/bogus'), { section: 'tasks', sub: 'queue' });
  assert.deepEqual(parseHash('#/chat/whatever'), { section: 'chat', sub: null });
});
