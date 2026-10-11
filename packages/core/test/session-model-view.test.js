import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { writeCompactSettings } from '../dist/session/compact-settings.js';
import { buildSessionModelView } from '../dist/session/model-view.js';
import { DEFAULT_MICRO_COMPACT_CONFIG } from '../dist/session/micro-compact.js';

function seedConsumedBashSession(store) {
  const session = store.createSession({
    title: 'model-view',
    mode: 'chat',
    agentId: 'general'
  });
  const longDump = `MODEL_VIEW_BASH_MARKER-${'x'.repeat(180)}`;
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'run long bash dump' }]);
  store.appendMessage(session.id, 'assistant', [
    {
      type: 'tool_call',
      toolCallId: 'c-bash',
      name: 'bash',
      input: { command: 'node -e "console.log(1)"' }
    }
  ]);
  store.appendMessage(session.id, 'tool', [
    {
      type: 'tool_result',
      toolCallId: 'c-bash',
      name: 'bash',
      ok: true,
      content: longDump
    }
  ]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'done looking at the dump' }]);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello 再看一眼' }]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'ok' }]);
  return { session, longDump, messages: store.listMessages(session.id) };
}

test('same stored session: after_text_assistant collapses more than keep_recent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-model-view-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const { session, longDump, messages } = seedConsumedBashSession(store);

  writeCompactSettings(store, { policy: 'keep_recent', keepRecent: 3 });
  const keep = buildSessionModelView({ messages, store, env: {} });

  writeCompactSettings(store, { policy: 'after_text_assistant' });
  const after = buildSessionModelView({ messages, store, env: {} });

  assert.equal(keep.policy, 'keep_recent');
  assert.equal(after.policy, 'after_text_assistant');
  assert.notEqual(
    keep.stats.collapsed,
    after.stats.collapsed,
    'same session must report different collapsed under the two policies'
  );
  assert.equal(keep.stats.collapsed, 0, 'single recent result stays verbatim under keep_recent=3');
  assert.equal(after.stats.collapsed, 1);
  assert.ok(after.stats.charsSaved > 0);
  assert.match(after.modelView.find((m) => m.parts.some((p) => p.type === 'tool_result')).parts[0].content, /omitted to save space/);
  assert.equal(
    keep.modelView.find((m) => m.parts.some((p) => p.type === 'tool_result')).parts[0].content,
    longDump
  );

  const persisted = store.listMessages(session.id);
  const storedResult = persisted.find((m) => m.parts.some((p) => p.type === 'tool_result'));
  assert.equal(storedResult.parts[0].content, longDump, 'SQLite transcript stays full');

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buildSessionModelView accepts an explicit config override', () => {
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
          content: 'y'.repeat(200)
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
  const keep = buildSessionModelView({
    messages,
    config: { ...DEFAULT_MICRO_COMPACT_CONFIG, policy: 'keep_recent', keepRecent: 3, minChars: 100 }
  });
  const after = buildSessionModelView({
    messages,
    config: { ...DEFAULT_MICRO_COMPACT_CONFIG, policy: 'after_any_assistant', minChars: 100 }
  });
  assert.equal(keep.stats.collapsed, 0);
  assert.equal(after.stats.collapsed, 1);
  assert.notEqual(keep.stats.collapsed, after.stats.collapsed);
});
