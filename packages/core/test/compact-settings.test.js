import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  COMPACT_SETTINGS_KEY,
  defaultCompactSettings,
  hasPersistedCompactSettings,
  parseCompactPolicy,
  parseKeepRecent,
  readCompactSettings,
  resolveMicroCompactConfig,
  writeCompactSettings
} from '../dist/session/compact-settings.js';
import { microCompactMessages } from '../dist/session/micro-compact.js';

test('compact settings persist policy in daemon_control KV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-settings-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));

  assert.equal(hasPersistedCompactSettings(store), false);
  assert.equal(readCompactSettings(store).policy, 'keep_recent');
  assert.equal(readCompactSettings(store).keepRecent, 3);
  assert.equal(defaultCompactSettings().policy, 'keep_recent');
  assert.equal(parseCompactPolicy('nope'), undefined);
  assert.equal(parseCompactPolicy('after_text_assistant'), 'after_text_assistant');
  assert.equal(parseKeepRecent(8), 8);
  assert.equal(parseKeepRecent(-1), undefined);

  const envKeep = resolveMicroCompactConfig({
    store,
    env: { RAW_AGENT_MICRO_COMPACT_KEEP_RECENT: '7' }
  });
  assert.equal(envKeep.policy, 'keep_recent');
  assert.equal(envKeep.keepRecent, 7, 'env keepRecent wins until UI saves');

  const saved = writeCompactSettings(store, { policy: 'after_text_assistant', keepRecent: 2 });
  assert.equal(hasPersistedCompactSettings(store), true);
  assert.equal(saved.policy, 'after_text_assistant');
  assert.equal(readCompactSettings(store).keepRecent, 2);
  assert.equal(store.getDaemonControl(COMPACT_SETTINGS_KEY).policy, 'after_text_assistant');

  const resolved = resolveMicroCompactConfig({
    store,
    env: { RAW_AGENT_MICRO_COMPACT_KEEP_RECENT: '7' }
  });
  assert.equal(resolved.policy, 'after_text_assistant');
  assert.equal(resolved.keepRecent, 2, 'UI keepRecent overrides env after save');

  writeCompactSettings(store, { policy: 'keep_recent' });
  assert.equal(readCompactSettings(store).policy, 'keep_recent');
  assert.equal(readCompactSettings(store).keepRecent, 2, 'policy patch keeps keepRecent');

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('resolved after_text policy stubs consumed results in the model view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-resolve-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  writeCompactSettings(store, { policy: 'after_text_assistant' });
  const cfg = resolveMicroCompactConfig({ store, env: {} });

  const messages = [
    {
      id: 't1',
      sessionId: 's',
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          name: 'bash',
          ok: true,
          content: 'secret-path.txt'.padEnd(200, 'x')
        }
      ],
      createdAt: '2026-09-02T00:00:00.000Z'
    },
    {
      id: 'a1',
      sessionId: 's',
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }],
      createdAt: '2026-09-02T00:00:00.000Z'
    }
  ];
  const { messages: out, stats } = microCompactMessages(messages, cfg);
  assert.equal(stats.collapsed, 1);
  assert.match(out[0].parts[0].content, /omitted to save space/);

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
