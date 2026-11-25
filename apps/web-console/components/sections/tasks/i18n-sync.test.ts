import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../../../lib/i18n/messages/en/index.ts';
import { zh } from '../../../lib/i18n/messages/zh/index.ts';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leafKeys(v, `${prefix}${k}.`)
  );
}

test('任务页与知识页文案中英文键完全一致且非空 [AC:console-tasks#AC-7]', () => {
  for (const ns of ['tasks', 'knowledge', 'memory'] as const) {
    const zhKeys = leafKeys(zh[ns]).sort();
    const enKeys = leafKeys(en[ns]).sort();
    assert.ok(zhKeys.length > 0, `${ns} has messages`);
    assert.deepEqual(enKeys, zhKeys, `${ns} keys in sync`);
  }
});

function assertNonEmptyValues(value: unknown, pathPrefix: string): void {
  if (typeof value === 'string') {
    assert.ok(value.trim().length > 0, `${pathPrefix} must be non-empty`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNonEmptyValues(v, `${pathPrefix}.${k}`);
    }
  }
}

test('Bot 任务与任务队列重构文案中英文键完全一致且均非空 [AC:bot-tasks-queue-redesign#AC-8]', () => {
  for (const ns of ['botWork', 'tasks'] as const) {
    const zhKeys = leafKeys(zh[ns]).sort();
    const enKeys = leafKeys(en[ns]).sort();
    assert.ok(zhKeys.length > 0, `${ns} has messages`);
    assert.deepEqual(enKeys, zhKeys, `${ns} zh/en keys match`);
    assertNonEmptyValues(zh[ns], `zh.${ns}`);
    assertNonEmptyValues(en[ns], `en.${ns}`);
  }
});
