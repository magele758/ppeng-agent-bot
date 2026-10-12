import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './messages/en/index.ts';
import { zh } from './messages/zh/index.ts';

function collectLeafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  const keys: string[] = [];
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof child === 'string') {
      keys.push(path);
    } else {
      keys.push(...collectLeafKeys(child, path));
    }
  }
  return keys.sort();
}

test('en and zh leaf key sets are identical', () => {
  const zhKeys = collectLeafKeys(zh);
  const enKeys = collectLeafKeys(en);
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.includes('common.language'));
  assert.ok(zhKeys.includes('common.languageHint'));
  assert.ok(zhKeys.includes('nav.skipToContent'));
  assert.ok(zhKeys.includes('play.send'));
  assert.ok(zhKeys.includes('auth.google'));
  assert.ok(zhKeys.includes('more.help'));
  assert.equal(zh.tasks.inbox.loginRequiredToSend, '批准外发需要先开启登录');
  assert.ok(en.tasks.inbox.loginRequiredToSend.length > 0);
});

test('主导航与设置分类在中英文都有文案 [AC:console-navigation#AC-5]', () => {
  const sections = ['chat', 'agents', 'tasks', 'knowledge', 'ops', 'settings'] as const;
  for (const id of sections) {
    assert.ok(zh.shell.nav[id].length > 0);
    assert.ok(en.shell.nav[id].length > 0);
    assert.notEqual(zh.shell.nav[id], en.shell.nav[id]);
  }
  assert.deepEqual(Object.keys(zh.settings.categories), Object.keys(en.settings.categories));
});
