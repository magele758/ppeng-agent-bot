import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, groupItems, itemLabelKey, noteKey, reasonKey, type EffectiveItem } from './effective-config.ts';
import { getMessage } from './i18n/t.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

// 与 packages/core/src/config/effective-config.ts 对齐的全部 code；新增 code 时须同步 zh/en。
const NOTE_CODES = [
  'invalid_provider_value',
  'redis_optional_missing',
  'partial_s3',
  'session_postgres_not_migrated',
  'session_still_sqlite',
  'pg_unreachable',
  'pg_schema_missing',
  'redis_unreachable',
  'web_search_missing_query',
  'mcp_stdio_invalid',
  'mcp_http_invalid',
  'vl_missing_endpoint',
  'embedding_no_key',
  'embedding_partial',
  'embedding_can_reuse_chat_key',
  'gateway_no_config',
  'gateway_config_detected',
  'local_binaries_detected'
];

const REASON_CODES = [
  'not_configured',
  'partial_config',
  'manual_only',
  'explicit_on',
  'explicit_off',
  'explicit_provider',
  'explicit_local',
  'explicit_provider_unmigrated',
  'database_url_set',
  'redis_url_set',
  's3_complete',
  'sqlite_only',
  'runtime_fallback',
  'lab_template',
  'lab_cleared',
  'env_template',
  'mcp_configured',
  'mcp_connected',
  'vl_configured',
  'embedding_env_set',
  'embedding_partial',
  'lab_on',
  'lab_off',
  'lab_on_no_key',
  'explicit_domains',
  'domain_credentials'
];

const ITEM_IDS = [
  'storage.sessionStore',
  'storage.eventBuffer',
  'storage.skillRegistry',
  'storage.assetStorage',
  'storage.dispatchLock',
  'capability.webSearch',
  'capability.mcp',
  'capability.vision',
  'capability.embeddingRecall',
  'capability.domains',
  'capability.gateway',
  'manual.externalAiTools',
  'manual.browser',
  'manual.cron',
  'manual.a2ui',
  'manual.discovery'
];

test('code → i18n key mapping', () => {
  assert.equal(noteKey('partial_s3'), 'config.notePartialS3');
  assert.equal(reasonKey('lab_on_no_key'), 'config.reasonLabOnNoKey');
  assert.equal(itemLabelKey('storage.eventBuffer'), 'config.itemEventBuffer');
  assert.equal(itemLabelKey('manual.a2ui'), 'config.itemA2ui');
});

test('every note / reason code and item id has zh + en copy', () => {
  const keys = [
    ...NOTE_CODES.map(noteKey),
    ...REASON_CODES.map(reasonKey),
    ...ITEM_IDS.map(itemLabelKey)
  ];
  for (const key of keys) {
    assert.equal(typeof getMessage(zh, key), 'string', `zh missing ${key}`);
    assert.equal(typeof getMessage(en, key), 'string', `en missing ${key}`);
  }
});

test('groupItems keeps storage → capability → manual order and drops empty groups', () => {
  const mk = (id: string, group: EffectiveItem['group']): EffectiveItem => ({
    id,
    group,
    enabled: false,
    mode: 'off',
    source: 'local-fallback',
    reasonCode: 'not_configured',
    reason: '',
    warnings: [],
    hints: []
  });
  const grouped = groupItems([mk('manual.cron', 'manual'), mk('storage.eventBuffer', 'storage')]);
  assert.deepEqual(
    grouped.map((g) => g.group),
    ['storage', 'manual']
  );
});

test('attentionItems keeps only items with warnings [AC:ops-console#AC-7]', () => {
  const mk = (id: string, warnings: number): EffectiveItem => ({
    id,
    group: 'capability',
    enabled: true,
    mode: 'x',
    source: 'lab',
    reasonCode: 'lab_on',
    reason: '',
    warnings: Array.from({ length: warnings }, () => ({ code: 'pg_unreachable', message: 'x' })),
    hints: []
  });
  const items = [mk('a', 0), mk('b', 1), mk('c', 2)];
  assert.deepEqual(attentionItems(items).map((i) => i.id), ['b', 'c']);
  assert.equal(attentionItems([mk('a', 0)]).length, 0);
});
