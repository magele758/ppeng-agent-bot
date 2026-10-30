import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurablePagePort } from '../dist/library/index.js';
import { SqliteStateStore } from '../dist/storage.js';
import { ValidationError, NotFoundError } from '../dist/errors.js';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dur-page-'));
  const store = new SqliteStateStore(join(dir, 'state.sqlite'));
  try {
    return fn(store);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('创建页面得到第 1 版、分享路径和只读正文 [AC:durable-page-port#AC-1]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page = port.create({ title: '  发布说明  ', markdown: '# 你好\n\n正文' });
    assert.match(page.id, /^page_/);
    assert.equal(page.revision, 1);
    assert.match(page.shareId, /^share_/);
    assert.equal(page.sharePath, `/pages/${page.shareId}`);
    assert.equal(page.title, '发布说明');
    assert.equal(page.markdown, '# 你好\n\n正文');
    assert.equal(page.surface[0].createSurface.catalogId.includes('basic_catalog'), true);
    const text = page.surface[1].updateComponents.components.find((c) => c.id === 'markdown');
    assert.equal(text.text, '# 你好\n\n正文');
    assert.equal(JSON.stringify(page.surface).includes('Button'), false);
  });
});

test('改正文升版本且分享 id 不变，原样提交不升版本 [AC:durable-page-port#AC-2]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const created = port.create({ title: '笔记', markdown: '第一版' });
    const updated = port.update({ id: created.id, markdown: '第二版' });
    assert.equal(updated.revision, 2);
    assert.equal(updated.shareId, created.shareId);
    assert.equal(updated.title, '笔记');
    assert.equal(updated.markdown, '第二版');
    assert.equal(updated.surface[1].updateComponents.components.find((c) => c.id === 'markdown').text, '第二版');
    const same = port.update({ id: created.id, title: '笔记', markdown: '第二版' });
    assert.equal(same.revision, 2);
    assert.equal(same.updatedAt, updated.updatedAt);
  });
});

test('分享 id 读回正文，列表不含正文 [AC:durable-page-port#AC-3]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const created = port.create({ title: '分享页', markdown: '只有链接能看见' });
    const shared = port.getByShareId(created.shareId);
    assert.equal(shared.id, created.id);
    assert.equal(shared.markdown, '只有链接能看见');
    const listed = port.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].title, '分享页');
    assert.equal(listed[0].sharePath, created.sharePath);
    assert.equal('markdown' in listed[0], false);
  });
});

test('重新打开同一状态库仍能按 id 和分享 id 读回 [AC:durable-page-port#AC-4]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dur-page-reopen-'));
  const dbPath = join(dir, 'state.sqlite');
  try {
    const first = new SqliteStateStore(dbPath);
    const created = createDurablePagePort(first).create({ title: '留下', markdown: '跨进程正文' });
    first.db.close();
    const again = new SqliteStateStore(dbPath);
    try {
      const port = createDurablePagePort(again);
      const byId = port.get(created.id);
      const byShare = port.getByShareId(created.shareId);
      assert.equal(byId.markdown, '跨进程正文');
      assert.equal(byId.revision, 1);
      assert.equal(byShare.markdown, byId.markdown);
      assert.equal(byShare.shareId, created.shareId);
    } finally {
      again.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空标题不落库，不存在的 id 和分享 id 读不到 [AC:durable-page-port#AC-5]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    assert.throws(() => port.create({ title: '   ', markdown: 'x' }), ValidationError);
    assert.equal(port.list().length, 0);
    assert.throws(() => port.get('page_missing'), NotFoundError);
    assert.throws(() => port.getByShareId('share_missing'), NotFoundError);
    assert.throws(() => port.update({ id: 'page_missing', markdown: 'nope' }), NotFoundError);
  });
});
