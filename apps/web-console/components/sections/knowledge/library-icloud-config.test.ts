import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyLibraryPick,
  libraryIndexRunning,
  libraryRejectKey,
  librarySaveFailureView,
  librarySaveView
} from './library-dirs-model.ts';
import { knowledge as zh } from '../../../lib/i18n/messages/zh/knowledge.ts';
import { knowledge as en } from '../../../lib/i18n/messages/en/knowledge.ts';

const card = readFileSync(new URL('./LibraryDirsCard.tsx', import.meta.url), 'utf8');
const vault = '/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Mac-Knowledge';

test('已存在的资料目录再次保存显示已保存，索引还在进行也一样 [AC:library-icloud-config#AC-1]', () => {
  const saved = librarySaveView({
    action: 'saved',
    previous: [vault],
    returnedDirs: [vault],
    indexRunning: true
  });
  assert.equal(saved.kind, 'message');
  if (saved.kind === 'message') {
    assert.equal(saved.messageKey, 'knowledge.library.saved');
    assert.deepEqual(saved.dirs, [vault]);
  }
  assert.equal(libraryIndexRunning({ indexing: true }), true);
  assert.equal(libraryIndexRunning({ index: 'running' }), true);

  const recovered = librarySaveFailureView({
    action: 'saved',
    intended: [vault],
    errorMessage: 'socket hang up',
    loaded: [vault]
  });
  assert.equal(recovered.kind, 'message');
  if (recovered.kind === 'message') assert.equal(recovered.messageKey, 'knowledge.library.saved');

  assert.match(card, /librarySaveView/);
  assert.match(card, /librarySaveFailureView/);
  assert.doesNotMatch(card, /error: 'not saved'/);
});

test('不存在、读不到和禁止访问在界面上是不同说明 [AC:library-icloud-config#AC-2]', () => {
  const picked = applyLibraryPick([vault], { status: 'rejected', reason: 'missing' });
  assert.equal(picked.action, 'rejected');
  if (picked.action === 'rejected') assert.equal(libraryRejectKey(picked.reason), 'knowledge.library.missing');
  assert.equal(libraryRejectKey('unreadable'), 'knowledge.library.unreadable');
  assert.equal(libraryRejectKey('denied'), 'knowledge.library.denied');
  assert.equal(libraryRejectKey('not-folder'), 'knowledge.library.notFolder');

  const missing = librarySaveFailureView({
    action: 'saved',
    intended: ['/tmp/mac-knowlodge'],
    errorMessage: 'Folder does not exist',
    loaded: ['/tmp/mac-knowlodge']
  });
  assert.equal(missing.kind, 'error');
  if (missing.kind === 'error') assert.equal(missing.errorKey, 'knowledge.library.missing');

  const unreadable = librarySaveFailureView({
    action: 'saved',
    intended: ['/tmp/blocked-file/Mac-Knowledge'],
    errorMessage: 'That folder could not be read',
    loaded: null
  });
  assert.equal(unreadable.kind, 'error');
  if (unreadable.kind === 'error') assert.equal(unreadable.errorKey, 'knowledge.library.unreadable');

  const denied = librarySaveFailureView({
    action: 'saved',
    intended: ['/tmp/secrets'],
    errorMessage: 'That folder is not allowed',
    loaded: null
  });
  assert.equal(denied.kind, 'error');
  if (denied.kind === 'error') assert.equal(denied.errorKey, 'knowledge.library.denied');

  assert.equal(zh.library.missing.includes('不存在'), true);
  assert.equal(zh.library.missing.includes('不允许'), false);
  assert.equal(en.library.missing.toLowerCase().includes('not allowed'), false);
  assert.equal(zh.library.unreadable.includes('读不到'), true);
  assert.equal(en.library.unreadable.toLowerCase().includes('could not be read'), true);
  assert.equal(zh.library.denied.includes('不允许'), true);
  assert.equal(en.library.denied.toLowerCase().includes('not allowed'), true);
  assert.match(card, /libraryRejectKey/);
});
