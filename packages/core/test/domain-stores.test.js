import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStateStore } from '../dist/storage.js';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../dist/stores/session-store.js';
import { ImageAssetStore } from '../dist/stores/image-asset-store.js';

const DB_PATH = join(import.meta.dirname, '..', `.tmp-test-stores-${process.pid}.db`);
let db;
let sessionStore;
let imageStore;

// Shared setup/teardown for both suites
before(() => {
  // Exercise domain stores against the production schema and migrations.
  db = new SqliteStateStore(DB_PATH).db;
  sessionStore = new SessionStore(db);
  imageStore = new ImageAssetStore(db);
});

after(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    const f = DB_PATH + ext;
    if (existsSync(f)) unlinkSync(f);
  }
});

describe('SessionStore', () => {

  it('creates a session with defaults', () => {
    const s = sessionStore.createSession({ title: 'Test', mode: 'chat', agentId: 'agent1' });
    assert.ok(s.id.startsWith('session_'));
    assert.equal(s.title, 'Test');
    assert.equal(s.mode, 'chat');
    assert.equal(s.status, 'idle');
    assert.equal(s.agentId, 'agent1');
    assert.equal(s.background, false);
    assert.deepEqual(s.todo, []);
    assert.deepEqual(s.metadata, {});
  });

  it('creates session with optional fields', () => {
    const s = sessionStore.createSession({
      title: 'BG Session',
      mode: 'task',
      agentId: 'agent2',
      taskId: 'task1',
      workspaceId: 'ws1',
      parentSessionId: 'parent1',
      background: true,
      summary: 'A background task',
      metadata: { key: 'value' }
    });
    assert.equal(s.mode, 'task');
    assert.equal(s.taskId, 'task1');
    assert.equal(s.workspaceId, 'ws1');
    assert.equal(s.parentSessionId, 'parent1');
    assert.equal(s.background, true);
    assert.equal(s.summary, 'A background task');
    assert.deepEqual(s.metadata, { key: 'value' });
  });

  it('gets session by ID', () => {
    const s = sessionStore.createSession({ title: 'Get Test', mode: 'chat', agentId: 'a1' });
    const found = sessionStore.getSession(s.id);
    assert.equal(found.id, s.id);
    assert.equal(found.title, 'Get Test');
  });

  it('returns undefined for missing session', () => {
    assert.equal(sessionStore.getSession('nonexistent'), undefined);
  });

  it('lists all sessions ordered by updated_at DESC', () => {
    const list = sessionStore.listSessions();
    assert.ok(list.length >= 2);
    // Verify ordering: newest first
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].updatedAt >= list[i].updatedAt);
    }
  });

  it('updates session fields', () => {
    const s = sessionStore.createSession({ title: 'Update Me', mode: 'chat', agentId: 'a1' });
    const updated = sessionStore.updateSession(s.id, {
      title: 'Updated Title',
      status: 'running',
      summary: 'Now running'
    });
    assert.equal(updated.title, 'Updated Title');
    assert.equal(updated.status, 'running');
    assert.equal(updated.summary, 'Now running');
    assert.ok(updated.updatedAt >= s.updatedAt);
  });

  it('throws on updating nonexistent session', () => {
    assert.throws(() => sessionStore.updateSession('nope', { title: 'x' }), /not found/);
  });

  it('appends a message and updates session.updatedAt', () => {
    const s = sessionStore.createSession({ title: 'Msg Test', mode: 'chat', agentId: 'a1' });
    const oldUpdated = s.updatedAt;

    // Small delay to ensure different timestamp
    const msg = sessionStore.appendMessage(s.id, 'user', [{ type: 'text', text: 'hello' }]);
    assert.ok(msg.id.startsWith('msg_'));
    assert.equal(msg.sessionId, s.id);
    assert.equal(msg.role, 'user');
    assert.deepEqual(msg.parts, [{ type: 'text', text: 'hello' }]);

    const refreshed = sessionStore.getSession(s.id);
    assert.ok(refreshed.updatedAt >= oldUpdated);
  });

  it('lists messages in chronological order', () => {
    const s = sessionStore.createSession({ title: 'MsgList', mode: 'chat', agentId: 'a1' });
    sessionStore.appendMessage(s.id, 'user', [{ type: 'text', text: 'first' }]);
    sessionStore.appendMessage(s.id, 'assistant', [{ type: 'text', text: 'second' }]);
    sessionStore.appendMessage(s.id, 'user', [{ type: 'text', text: 'third' }]);

    const msgs = sessionStore.listMessages(s.id);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].parts[0].text, 'first');
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[2].parts[0].text, 'third');
  });

  it('returns empty array for session with no messages', () => {
    const s = sessionStore.createSession({ title: 'Empty', mode: 'chat', agentId: 'a1' });
    assert.deepEqual(sessionStore.listMessages(s.id), []);
  });

  it('handles complex message parts (tool_call, tool_result)', () => {
    const s = sessionStore.createSession({ title: 'Complex', mode: 'chat', agentId: 'a1' });
    const parts = [
      { type: 'tool_call', toolCallId: 'tc1', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolCallId: 'tc1', name: 'bash', content: 'file.txt', ok: true }
    ];
    sessionStore.appendMessage(s.id, 'assistant', parts);
    const msgs = sessionStore.listMessages(s.id);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].parts, parts);
  });

  it('preserves metadata with nested objects', () => {
    const meta = { deep: { nested: { key: [1, 2, 3] } }, flag: true };
    const s = sessionStore.createSession({ title: 'Meta', mode: 'chat', agentId: 'a1', metadata: meta });
    const found = sessionStore.getSession(s.id);
    assert.deepEqual(found.metadata, meta);
  });
});

describe('ImageAssetStore', () => {
  const sampleAsset = () => ({
    id: `img_${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess1',
    sha256: 'abc123def456',
    mimeType: 'image/png',
    sourceType: 'upload',
    localRelPath: 'images/sess1/test.png',
    sizeBytes: 1024,
    derivedFromIds: [],
    retentionTier: 'hot',
    kind: 'original',
    lastAccessAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  });

  it('creates and retrieves an image asset', () => {
    const asset = sampleAsset();
    imageStore.createImageAsset(asset);
    const found = imageStore.getImageAsset(asset.id);
    assert.equal(found.id, asset.id);
    assert.equal(found.sha256, 'abc123def456');
    assert.equal(found.mimeType, 'image/png');
    assert.equal(found.sizeBytes, 1024);
  });

  it('returns undefined for missing asset', () => {
    assert.equal(imageStore.getImageAsset('nonexistent'), undefined);
  });

  it('lists assets for session in chronological order', () => {
    const a1 = { ...sampleAsset(), sessionId: 'list-sess' };
    const a2 = { ...sampleAsset(), sessionId: 'list-sess', createdAt: new Date(Date.now() + 1000).toISOString() };
    imageStore.createImageAsset(a1);
    imageStore.createImageAsset(a2);

    const list = imageStore.listImageAssetsForSession('list-sess');
    assert.equal(list.length, 2);
    assert.ok(list[0].createdAt <= list[1].createdAt);
  });

  it('returns empty array for session with no assets', () => {
    assert.deepEqual(imageStore.listImageAssetsForSession('no-assets'), []);
  });

  it('updates retention tier and lastAccessAt', () => {
    const asset = sampleAsset();
    imageStore.createImageAsset(asset);
    const newAccess = new Date(Date.now() + 5000).toISOString();
    const updated = imageStore.updateImageAsset(asset.id, {
      retentionTier: 'warm',
      lastAccessAt: newAccess
    });
    assert.equal(updated.retentionTier, 'warm');
    assert.equal(updated.lastAccessAt, newAccess);
    // Other fields unchanged
    assert.equal(updated.sha256, asset.sha256);
  });

  it('throws on updating nonexistent asset', () => {
    assert.throws(() => imageStore.updateImageAsset('nope', { retentionTier: 'cold' }), /not found/);
  });

  it('deletes an asset', () => {
    const asset = sampleAsset();
    imageStore.createImageAsset(asset);
    assert.ok(imageStore.getImageAsset(asset.id));
    imageStore.deleteImageAsset(asset.id);
    assert.equal(imageStore.getImageAsset(asset.id), undefined);
  });

  it('handles sourceUrl and derivedFromIds', () => {
    const asset = {
      ...sampleAsset(),
      sourceType: 'url',
      sourceUrl: 'https://example.com/photo.jpg',
      derivedFromIds: ['img_parent1', 'img_parent2'],
      kind: 'contact_sheet'
    };
    imageStore.createImageAsset(asset);
    const found = imageStore.getImageAsset(asset.id);
    assert.equal(found.sourceUrl, 'https://example.com/photo.jpg');
    assert.deepEqual(found.derivedFromIds, ['img_parent1', 'img_parent2']);
    assert.equal(found.kind, 'contact_sheet');
  });

  it('handles null sourceUrl', () => {
    const asset = { ...sampleAsset(), sourceUrl: undefined };
    imageStore.createImageAsset(asset);
    const found = imageStore.getImageAsset(asset.id);
    assert.equal(found.sourceUrl, undefined);
  });
});
