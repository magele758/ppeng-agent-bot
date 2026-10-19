/**
 * Schema upgrade tests: each snapshot in scripts/migration-fixtures/snapshots was written
 * by the revision that introduced that schema version (see generate.mjs). Opening it with
 * the current store must reach the latest version without losing rows, fill new columns
 * with safe defaults, and keep the data invariants later code relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RawAgentRuntime } from '@ppeng/agent-core';
import { SqliteStateStore } from '../../packages/core/dist/storage.js';
import { LATEST_SCHEMA_VERSION, getCurrentSchemaVersion } from '../../packages/core/dist/stores/migrations/index.js';
import { botPolicyWarnings } from '../../packages/core/dist/bots/bot-policy.js';
import { loadSqlDump } from '../migration-fixtures/sql-dump.mjs';

const SNAPSHOT_DIR = new URL('../migration-fixtures/snapshots/', import.meta.url);

function readSnapshot(file) {
  const sql = readFileSync(new URL(file, SNAPSHOT_DIR), 'utf8');
  const idsLine = sql.split('\n').find((line) => line.startsWith('-- seed ids: '));
  assert.ok(idsLine, `${file} has a seed ids header`);
  return { sql, ids: JSON.parse(idsLine.slice('-- seed ids: '.length)) };
}

const SNAPSHOTS = readdirSync(SNAPSHOT_DIR)
  .filter((file) => /^v\d+\.sql$/.test(file))
  .sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4)))
  .map((file) => ({ file, ...readSnapshot(file) }));

/** Load a snapshot into a fresh file at its old version, then open it with the current store. */
function restore(snapshot, dbFile = join(mkdtempSync(join(tmpdir(), 'schema-snap-')), 'runtime.sqlite')) {
  const raw = new DatabaseSync(dbFile);
  loadSqlDump(raw, snapshot.sql);
  const before = getCurrentSchemaVersion(raw);
  raw.close();
  return { dbFile, before, store: new SqliteStateStore(dbFile) };
}

function memoryKeys(rows) {
  return rows.map((row) => row.key).sort();
}

test('snapshots cover the last schema versions, including the one right before latest [AC:schema-upgrade-safety#AC-1]', () => {
  const versions = SNAPSHOTS.map((s) => s.ids.version);
  assert.ok(versions.length >= 4, `expected >= 4 snapshots, got ${versions.join(',')}`);
  assert.ok(versions.includes(20), 'v20 (before agent_memory.agent_id) is covered');
  assert.ok(versions.includes(LATEST_SCHEMA_VERSION - 1), 'the version right before latest is covered');
  for (const snapshot of SNAPSHOTS) assert.equal(Number(snapshot.file.slice(1, -4)), snapshot.ids.version);
});

for (const snapshot of SNAPSHOTS) {
  const v = snapshot.ids.version;
  const { ids } = snapshot;

  test(`v${v} -> latest: migrates in place and is idempotent [AC:schema-upgrade-safety#AC-1]`, () => {
    const { dbFile, before, store } = restore(snapshot);
    assert.equal(before, v);
    const db = store.db;
    assert.equal(getCurrentSchemaVersion(db), LATEST_SCHEMA_VERSION);
    const recorded = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    assert.deepEqual(recorded, Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const counts = () =>
      Object.fromEntries(
        ['sessions', 'messages', 'tasks', 'approvals', 'agent_memory', 'bots'].map((t) => {
          const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
          return [t, exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : -1];
        })
      );
    const first = counts();
    db.close();
    const reopened = new SqliteStateStore(dbFile);
    assert.equal(getCurrentSchemaVersion(reopened.db), LATEST_SCHEMA_VERSION);
    const second = Object.fromEntries(
      Object.keys(first).map((t) => [t, first[t] === -1 ? -1 : reopened.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
    );
    assert.deepEqual(second, first);
    reopened.db.close();
  });

  test(`v${v} -> latest: sessions, messages, tasks and approvals survive [AC:schema-upgrade-safety#AC-2]`, () => {
    const { store } = restore(snapshot);
    const chat = store.getSession(ids.chatId);
    assert.equal(chat?.title, 'plain chat');
    assert.equal(chat.agentId, 'general');
    assert.equal(chat.metadata?.userId, 'u1');
    const messages = store.listMessages(ids.chatId);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    const call = messages[1].parts.find((p) => p.type === 'tool_call');
    assert.deepEqual([call.toolCallId, call.name, call.input], ['call_seed_1', 'bash', { command: 'ls' }]);
    const result = messages[2].parts[0];
    assert.deepEqual([result.type, result.toolCallId, result.ok, result.content], ['tool_result', 'call_seed_1', true, 'README.md']);

    const task = store.getTask(ids.taskId);
    assert.equal(task?.title, 'seeded task');
    assert.equal(task.ownerAgentId, 'reviewer');
    assert.equal(store.getSession(ids.taskSessionId)?.taskId, ids.taskId);
    const approval = store.getApproval(ids.approvalId);
    assert.equal(approval?.status, 'pending');
    assert.equal(approval.toolName, 'bash');
    assert.deepEqual(approval.args, { command: 'touch x' });
    assert.ok(store.getAgent('general') && store.getAgent('reviewer'));
    store.db.close();
  });

  test(`v${v} -> latest: memory rows keep values, new columns default, FTS answers [AC:schema-upgrade-safety#AC-3]`, () => {
    const { store } = restore(snapshot);
    const columns = store.db.prepare('PRAGMA table_info(agent_memory)').all().map((c) => c.name);
    assert.ok(columns.includes('agent_id'));
    const memory = store.agentMemory();
    const shared = memory.search({ scope: 'user.memory', userId: 'u1', agentUnscoped: true, limit: 50 });
    assert.ok(memoryKeys(shared).includes('shared-pref'));
    assert.ok(memoryKeys(shared).includes('global-pref'));
    assert.equal(shared.find((m) => m.key === 'shared-pref').value, 'prefers short answers (general chat)');
    assert.equal(shared.find((m) => m.key === 'global-pref').agentId, undefined);
    const long = memory.search({ scope: 'session.long', sessionId: ids.chatId, limit: 10 });
    assert.deepEqual(memoryKeys(long), ['chat-long']);
    const hits = memory.search({ scope: 'user.memory', userId: 'u1', query: 'timezone', agentUnscoped: true, limit: 5 });
    assert.deepEqual(memoryKeys(hits), ['global-pref']);
    assert.equal(memory.getUser('u1')?.email, 'user-one@example.invalid');
    store.db.close();
  });

  if (!ids.bots) continue;

  // seed.mjs writes bot memory without agent_id; from v22 on the backfill has already run on the empty DB
  // and the real write path tags rows, so such rows only exist in pre-v22 databases.
  if (v < 22) test(`v${v} -> latest: legacy bot memory moves into the bot namespace`, () => {
    const { store } = restore(snapshot);
    const { researcher } = ids.bots;
    assert.equal(store.getBot(researcher.id)?.canonicalSessionId, researcher.sessionId);
    const memory = store.agentMemory();
    const shared = memoryKeys(memory.search({ scope: 'user.memory', userId: 'u1', agentUnscoped: true, limit: 50 }));
    assert.deepEqual(shared, ['global-pref', 'shared-pref'], 'bot-written rows are not on the shared pool');
    const own = memory.search({ scope: 'user.memory', userId: 'u1', agentId: researcher.agentId, limit: 50 });
    assert.deepEqual(memoryKeys(own), ['bot-child-pref', 'bot-pref']);
    assert.equal(own.find((m) => m.key === 'bot-pref').value, 'likes tea (written by Researcher)');
    assert.deepEqual(memoryKeys(memory.search({ scope: 'user.memory', userId: 'u1', agentId: 'planner', limit: 50 })), []);
    const botLong = memory.search({ scope: 'session.long', sessionId: researcher.sessionId, limit: 10 });
    assert.deepEqual(memoryKeys(botLong), ['bot-long']);
    store.db.close();
  });

  test(`v${v} -> latest: a bot that got bypass by default is flagged, a user-chosen tier is not [AC:bots#AC-6]`, () => {
    const { store } = restore(snapshot);
    const { researcher, planner } = ids.bots;
    const researcherMeta = store.getSession(researcher.sessionId).metadata;
    const plannerMeta = store.getSession(planner.sessionId).metadata;
    assert.equal(plannerMeta.permissionMode, 'ask');
    assert.deepEqual(botPolicyWarnings(plannerMeta), []);
    if (researcherMeta.permissionMode === 'bypass') {
      assert.deepEqual(botPolicyWarnings(researcherMeta), [{ code: 'legacy_bypass_permission' }]);
    } else {
      assert.deepEqual(botPolicyWarnings(researcherMeta), []);
    }
    store.db.close();
  });

  // v29 adds bots.avatar with no DEFAULT clause, so an upgraded row stays NULL.
  if (v < 29) test(`v${v} -> latest: bots.avatar defaults to NULL [AC:schema-upgrade-safety#AC-1]`, () => {
    const { store } = restore(snapshot);
    const { researcher, planner } = ids.bots;
    const columns = store.db.prepare('PRAGMA table_info(bots)').all();
    const avatar = columns.find((column) => column.name === 'avatar');
    assert.ok(avatar, 'bots.avatar exists after upgrade');
    assert.equal(avatar.dflt_value, null);
    for (const id of [researcher.id, planner.id]) {
      assert.equal(store.db.prepare('SELECT avatar FROM bots WHERE id=?').get(id).avatar, null);
      assert.equal(store.getBot(id).avatar, null);
    }
    store.db.close();
  });

  // v32 adds session_messages.reply_to_json with no DEFAULT, so a pre-existing row stays NULL.
  if (v < 32) test(`v${v} -> latest: session_messages.reply_to_json defaults to NULL [AC:schema-upgrade-safety#AC-1]`, () => {
    const { store } = restore(snapshot);
    const columns = store.db.prepare('PRAGMA table_info(session_messages)').all();
    const replyTo = columns.find((column) => column.name === 'reply_to_json');
    assert.ok(replyTo, 'session_messages.reply_to_json exists after upgrade');
    assert.equal(replyTo.dflt_value, null);
    const rows = store.db.prepare('SELECT reply_to_json FROM session_messages').all();
    for (const row of rows) assert.equal(row.reply_to_json, null);
    store.db.close();
  });

  // v30 adds bot_work_messages.source_room with no DEFAULT, so a pre-existing row stays NULL.
  if (v < 30) test(`v${v} -> latest: bot_work_messages.source_room defaults to NULL [AC:schema-upgrade-safety#AC-1]`, () => {
    const { store } = restore(snapshot);
    const columns = store.db.prepare('PRAGMA table_info(bot_work_messages)').all();
    const sourceRoom = columns.find((column) => column.name === 'source_room');
    assert.ok(sourceRoom, 'bot_work_messages.source_room exists after upgrade');
    assert.equal(sourceRoom.dflt_value, null);
    const rows = store.db.prepare('SELECT source_room FROM bot_work_messages').all();
    for (const row of rows) assert.equal(row.source_room, null);
    store.db.close();
  });
}

test('v20 -> latest through the runtime: warning is served until the owner picks a tier [AC:bots#AC-6]', () => {
  const snapshot = SNAPSHOTS.find((s) => s.ids.version === 20);
  const stateDir = mkdtempSync(join(tmpdir(), 'schema-snap-rt-'));
  restore(snapshot, join(stateDir, 'runtime.sqlite')).store.db.close();
  const runtime = new RawAgentRuntime({ repoRoot: mkdtempSync(join(tmpdir(), 'schema-snap-repo-')), stateDir });
  const { researcher, planner } = snapshot.ids.bots;
  assert.equal(runtime.store.getSession(researcher.sessionId).metadata.permissionMode, 'bypass', 'never silently downgraded');
  assert.deepEqual(
    runtime.getBotPolicyWarnings(researcher.id).filter((w) => w.code === 'legacy_bypass_permission'),
    [{ code: 'legacy_bypass_permission' }]
  );
  assert.deepEqual(runtime.getBotPolicyWarnings(planner.id), []);
  runtime.setPermissionMode(researcher.sessionId, { mode: 'bypass' });
  assert.deepEqual(runtime.getBotPolicyWarnings(researcher.id), [], 'an explicit choice clears the flag');
  runtime.store.db.close();
});

test('fresh DB reaches latest with the same schema as an upgraded one [AC:schema-upgrade-safety#AC-5]', () => {
  const fresh = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), 'schema-fresh-')), 'runtime.sqlite'));
  const upgraded = restore(SNAPSHOTS[SNAPSHOTS.length - 1]).store;
  const shape = (db) =>
    Object.fromEntries(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name`)
        .all()
        .map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name).sort()])
    );
  const freshShape = shape(fresh.db);
  const upgradedShape = shape(upgraded.db);
  for (const [table, cols] of Object.entries(upgradedShape)) {
    assert.deepEqual(freshShape[table], cols, `table ${table} matches a fresh DB`);
  }
  assert.equal(getCurrentSchemaVersion(fresh.db), LATEST_SCHEMA_VERSION);
  fresh.db.close();
  upgraded.db.close();
});
