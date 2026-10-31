import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../dist/stores/migrations/index.js';
import { LibraryPageStore } from '../dist/stores/library-page-store.js';
import { createDurablePagePort } from '../dist/library/durable-page-port.js';

test('page revisions - create archives revision 1', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  
  const store = new LibraryPageStore(db);
  const port = createDurablePagePort(store);
  
  // Create a page
  const page = port.create({
    title: 'Test Page',
    markdown: '# Hello'
  });
  
  assert.strictEqual(page.revision, 1, 'page revision should be 1');
  assert.strictEqual(page.title, 'Test Page');
  assert.strictEqual(page.markdown, '# Hello');
  
  // List revisions
  const revisions = port.listRevisions(page.id);
  assert.strictEqual(revisions.length, 1, 'should have 1 revision');
  assert.strictEqual(revisions[0].revision, 1);
  assert.strictEqual(revisions[0].title, 'Test Page');
  
  // Get revision
  const rev1 = port.getRevision(page.id, 1);
  assert.strictEqual(rev1.revision, 1);
  assert.strictEqual(rev1.title, 'Test Page');
  assert.strictEqual(rev1.markdown, '# Hello');
});

test('page revisions - update archives new revision', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  
  const store = new LibraryPageStore(db);
  const port = createDurablePagePort(store);
  
  // Create a page
  const page1 = port.create({
    title: 'Test Page',
    markdown: '# Hello'
  });
  
  // Update the page
  const page2 = port.update({
    id: page1.id,
    title: 'Updated Title',
    markdown: '# Hello World'
  });
  
  assert.strictEqual(page2.revision, 2, 'new revision should be 2');
  
  // List revisions - should have both
  const revisions = port.listRevisions(page1.id);
  assert.strictEqual(revisions.length, 2, 'should have 2 revisions');
  assert.strictEqual(revisions[0].revision, 2);
  assert.strictEqual(revisions[1].revision, 1);
  
  // Get old revision
  const rev1 = port.getRevision(page1.id, 1);
  assert.strictEqual(rev1.title, 'Test Page');
  assert.strictEqual(rev1.markdown, '# Hello');
  
  // Get new revision
  const rev2 = port.getRevision(page1.id, 2);
  assert.strictEqual(rev2.title, 'Updated Title');
  assert.strictEqual(rev2.markdown, '# Hello World');
});

test('page revisions - restore bumps revision', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  
  const store = new LibraryPageStore(db);
  const port = createDurablePagePort(store);
  
  // Create and update a page
  const page1 = port.create({
    title: 'Original',
    markdown: '# Original'
  });
  
  const page2 = port.update({
    id: page1.id,
    title: 'Modified',
    markdown: '# Modified'
  });
  
  assert.strictEqual(page2.revision, 2);
  
  // Restore revision 1
  const page3 = port.restoreRevision(page1.id, 1);
  
  assert.strictEqual(page3.revision, 3, 'restored page should be revision 3');
  assert.strictEqual(page3.title, 'Original', 'title should be from revision 1');
  assert.strictEqual(page3.markdown, '# Original', 'markdown should be from revision 1');
  
  // Should now have 3 revisions archived
  const revisions = port.listRevisions(page1.id);
  assert.strictEqual(revisions.length, 3, 'should have 3 revisions');
  
  // Verify revision 3 contains the restored content
  const rev3 = port.getRevision(page1.id, 3);
  assert.strictEqual(rev3.title, 'Original');
  assert.strictEqual(rev3.markdown, '# Original');
});

test('page revisions - delete clears revisions', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  
  const store = new LibraryPageStore(db);
  const port = createDurablePagePort(store);
  
  // Create and update a page
  const page = port.create({
    title: 'Test',
    markdown: '# Test'
  });
  
  port.update({
    id: page.id,
    markdown: '# Test v2'
  });
  
  // Verify revisions exist
  let revisions = port.listRevisions(page.id);
  assert.strictEqual(revisions.length, 2);
  
  // Delete the page
  port.delete(page.id);
  
  // Should not be able to get revisions for deleted page
  assert.throws(
    () => port.listRevisions(page.id),
    /Page/,
    'should throw NotFoundError for deleted page'
  );
  
  // Verify revision records were deleted
  const revisionsInDb = store.listRevisions(page.id);
  assert.strictEqual(revisionsInDb.length, 0, 'revisions should be deleted');
});

test('page revisions - no-op update does not create revision', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  
  const store = new LibraryPageStore(db);
  const port = createDurablePagePort(store);
  
  // Create a page
  const page1 = port.create({
    title: 'Test',
    markdown: '# Test'
  });
  
  // Update with same content
  const page2 = port.update({
    id: page1.id,
    title: 'Test',
    markdown: '# Test'
  });
  
  assert.strictEqual(page2.revision, 1, 'revision should not increment on no-op');
  
  const revisions = port.listRevisions(page1.id);
  assert.strictEqual(revisions.length, 1, 'should still have only 1 revision');
});
