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

test('play create menu names for a bot and a group do not overlap', () => {
  for (const messages of [zh, en]) {
    const bot = messages.play.newBot;
    const group = messages.agents.bots.newGroup;
    assert.notEqual(bot, group);
    assert.equal(group.includes(bot), false);
    assert.equal(messages.agents.bots.groupTitle.includes(bot), false);
  }
});

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
  const sections = ['bot', 'chat', 'agents', 'tasks', 'knowledge', 'settings'] as const;
  for (const id of sections) {
    assert.ok(zh.shell.nav[id].length > 0);
    assert.ok(en.shell.nav[id].length > 0);
    if (id !== 'bot') assert.notEqual(zh.shell.nav[id], en.shell.nav[id]);
  }
  assert.equal(zh.shell.nav.ops, '运维');
  assert.equal(en.shell.nav.ops, 'Ops');
  assert.notEqual(zh.shell.nav.collapse, en.shell.nav.collapse);
  assert.notEqual(zh.shell.nav.expand, en.shell.nav.expand);
  assert.equal(zh.settings.categories.ops, '运维');
  assert.equal(en.settings.categories.ops, 'Ops');
  assert.deepEqual(Object.keys(zh.settings.categories), Object.keys(en.settings.categories));
});
