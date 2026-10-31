import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurablePagePort } from '../dist/library/index.js';
import { SqliteStateStore } from '../dist/storage.js';
import { NotFoundError } from '../dist/errors.js';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'page-rev-'));
  const store = new SqliteStateStore(join(dir, 'state.sqlite'));
  try {
    return fn(store);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('create archives revision 1 [AC:page-revisions#AC-1] [AC:durable-page-port#AC-rev-1]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page = port.create({ title: 'Test Page', markdown: '# Hello' });
    assert.equal(page.revision, 1);
    const revisions = port.listRevisions(page.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revision, 1);
    assert.equal(revisions[0].title, 'Test Page');
    const rev1 = port.getRevision(page.id, 1);
    assert.equal(rev1.markdown, '# Hello');
  });
});

test('update archives new revision; old still readable [AC:page-revisions#AC-2]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page1 = port.create({ title: 'Test Page', markdown: '# Hello' });
    const page2 = port.update({ id: page1.id, title: 'Updated Title', markdown: '# Hello World' });
    assert.equal(page2.revision, 2);
    const revisions = port.listRevisions(page1.id);
    assert.equal(revisions.length, 2);
    assert.equal(port.getRevision(page1.id, 1).title, 'Test Page');
    assert.equal(port.getRevision(page1.id, 1).markdown, '# Hello');
    assert.equal(port.getRevision(page1.id, 2).title, 'Updated Title');
  });
});

test('restore returns old body and bumps revision [AC:page-revisions#AC-3]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page1 = port.create({ title: 'Original', markdown: '# Original' });
    port.update({ id: page1.id, title: 'Modified', markdown: '# Modified' });
    const page3 = port.restoreRevision(page1.id, 1);
    assert.equal(page3.revision, 3);
    assert.equal(page3.title, 'Original');
    assert.equal(page3.markdown, '# Original');
    assert.equal(port.listRevisions(page1.id).length, 3);
    assert.equal(port.getRevision(page1.id, 3).markdown, '# Original');
  });
});

test('delete makes revisions unreadable [AC:page-revisions#AC-4]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page = port.create({ title: 'Test', markdown: '# Test' });
    port.update({ id: page.id, markdown: '# Test v2' });
    assert.equal(port.listRevisions(page.id).length, 2);
    port.delete(page.id);
    assert.throws(() => port.listRevisions(page.id), NotFoundError);
    assert.throws(() => port.getRevision(page.id, 1), NotFoundError);
    assert.equal(store.listLibraryPageRevisions(page.id).length, 0);
  });
});

test('no-op update does not create revision [AC:page-revisions#AC-5]', () => {
  withStore((store) => {
    const port = createDurablePagePort(store);
    const page1 = port.create({ title: 'Test', markdown: '# Test' });
    const page2 = port.update({ id: page1.id, title: 'Test', markdown: '# Test' });
    assert.equal(page2.revision, 1);
    assert.equal(port.listRevisions(page1.id).length, 1);
  });
});
