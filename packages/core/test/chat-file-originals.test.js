import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintainImageRetention } from '../dist/image-assets.js';
import { chatAttachmentTool } from '../dist/tools/chat-attachment-tool.js';
import { RawAgentRuntime, runAutoCompact } from '../dist/index.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const upload = async (runtime, sid, fileName, dataBase64) =>
  (await runtime.ingestAttachmentBase64(sid, { fileName, dataBase64 })).attachment;

test('同名原件独立保存 [AC:chat-file-originals#AC-2]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chat-originals-'));
  const runtime = new RawAgentRuntime({ repoRoot: root, stateDir: root });
  t.after(async () => {
    await runtime.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  const sid = runtime.createChatSession({ title: 'versions' }).id;
  const old = await upload(runtime, sid, 'quote.pdf', Buffer.from('%PDF-old').toString('base64'));
  const next = await upload(runtime, sid, 'quote.pdf', Buffer.from('%PDF-new').toString('base64'));
  assert.notEqual(old.localRelPath, next.localRelPath);
  assert.equal(readFileSync(join(root, old.localRelPath), 'utf8'), '%PDF-old');
});

test('压缩与重新打开数据库后读取已发送的两个版本和图片 [AC:chat-file-originals#AC-2] [AC:chat-file-originals#AC-3]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chat-originals-'));
  const opts = { repoRoot: root, stateDir: root };
  const runtime = new RawAgentRuntime(opts);
  const sid = runtime.createChatSession({ title: 'mixed' }).id;
  const ids = [];
  for (const value of ['old-7321', 'new-9684']) {
    const file = await upload(runtime, sid, 'config.ts', Buffer.from(value).toString('base64'));
    runtime.sendUserMessage(sid, '查看配置', { attachmentIds: [file.id] });
    ids.push(file.id);
  }
  const image = await upload(runtime, sid, 'screen.png', png);
  runtime.sendUserMessage(sid, '查看图', { attachmentIds: [image.id] });
  const draft = await upload(runtime, sid, 'draft.txt', Buffer.from('PRIVATE DRAFT').toString('base64'));
  const other = runtime.createChatSession({ title: 'other' }).id;
  for (let i = 0; i < 8; i++)
    runtime.store.appendMessage(sid, 'assistant', [{ type: 'text', text: 'padding '.repeat(100) }]);
  runtime.sendUserMessage(sid, 'another question');
  const compacted = await runAutoCompact({
    store: runtime.store,
    session: runtime.getSession(sid),
    agent: { id: 'general', name: 'general', role: 'assistant', instructions: '', capabilities: [] },
    force: true,
    tokenThreshold: 1,
    keepRecent: 2,
    summarize: async () => 'summary without attachments'
  });
  assert.equal(compacted.didCompact, true);
  assert.ok(!JSON.stringify(runtime.store.foldMessages(sid)).includes('screen.png'));
  runtime.store.db
    .prepare("UPDATE image_assets SET retention_tier = 'cold', created_at = '2000-01-01' WHERE id = ?")
    .run(image.imageAssetId);
  await maintainImageRetention({ store: runtime.store, stateDir: root, session: runtime.getSession(sid) });
  await runtime.destroy();
  const restored = new RawAgentRuntime(opts);
  t.after(async () => {
    await restored.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  const sent = restored.store.listSentAttachments(sid);
  assert.deepEqual(
    sent.map((a) => a.id),
    [...ids, image.id]
  );
  assert.deepEqual(restored.store.listSentAttachments(other), []);
  const reader = chatAttachmentTool(restored.store);
  const context = (id) => ({ session: restored.getSession(id), stateDir: root });
  assert.equal((await reader.execute(context(sid), { id: draft.id })).ok, false);
  assert.equal((await reader.execute(context(other), { id: ids[0] })).ok, false);
  assert.throws(
    () => restored.sendUserMessage(other, 'wrong source', { attachmentIds: [ids[0]] }),
    /unavailable/
  );
  const page = await reader.execute(context(sid), { id: ids[0], offset: 4, maxChars: 4 });
  assert.match(JSON.parse(page.content).content, /7321/);
  assert.ok(restored.store.getAttachment(sent[0].id).emitText.includes('old-7321'));
  assert.ok(restored.store.getAttachment(sent[1].id).emitText.includes('new-9684'));
  assert.equal(
    readFileSync(join(root, restored.store.getImageAsset(sent[2].imageAssetId).localRelPath)).toString(
      'base64'
    ),
    png
  );
});
