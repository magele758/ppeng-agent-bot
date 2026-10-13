import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './messages/en/index.ts';
import { zh } from './messages/zh/index.ts';

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k)
  );
}

const CJK = /[\u3400-\u9fff\uff00-\uffef]/;

test('settingsEntries 中英文 key 集合一致且非空 [AC:settings-categories#AC-8]', () => {
  const zhLeaves = leaves(zh.settingsEntries);
  const enLeaves = leaves(en.settingsEntries);
  assert.ok(zhLeaves.length > 100, 'settingsEntries should hold the full copy for the four categories');
  assert.deepEqual(
    enLeaves.map(([k]) => k).sort(),
    zhLeaves.map(([k]) => k).sort()
  );
  for (const [key, value] of [...zhLeaves, ...enLeaves]) {
    assert.ok(value.trim().length > 0, `${key} must not be empty`);
  }
});

test('settingsEntries 英文文案不含中文字符 [AC:settings-categories#AC-8]', () => {
  for (const [key, value] of leaves(en.settingsEntries)) {
    assert.ok(!CJK.test(value), `en.settingsEntries.${key} contains CJK: ${value}`);
  }
});

test('每个设置条目都有标题、关键词与说明 [AC:settings-categories#AC-1] [AC:settings-categories#AC-7]', () => {
  const entries = [
    'agentLoop',
    'agentLoopEngine',
    'compact',
    'goal',
    'goalVerify',
    'sandbox',
    'sandboxCloudflare',
    'skills',
    'dynTools',
    'discovery',
    'connectors',
    'langfuse',
    'jev',
    'eventLog'
  ] as const;
  for (const locale of [zh, en]) {
    for (const id of entries) {
      const entry = locale.settingsEntries[id] as { title: string; keywords: string; desc: string };
      assert.ok(entry.title.length > 0, `${id}.title`);
      assert.ok(entry.keywords.length > 0, `${id}.keywords`);
      assert.ok(entry.desc.length > 0, `${id}.desc`);
    }
  }
});

test('大白话同义词写进了搜索关键词 [AC:settings-categories#AC-7]', () => {
  assert.match(zh.settingsEntries.compact.keywords, /上下文太长/);
  assert.match(zh.settingsEntries.eventLog.keywords, /审计/);
  assert.match(zh.settingsEntries.langfuse.keywords, /追踪/);
});
