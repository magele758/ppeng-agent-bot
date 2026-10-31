import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDelete,
  applyRotate,
  copySharePath,
  deletePage,
  loadPages,
  openPage,
  rotatePageShare
} from './library-pages-actions.ts';

const sample = {
  id: 'page_1',
  title: 'T',
  revision: 1,
  shareId: 'share_a',
  sharePath: '/pages/share_a',
  createdAt: '',
  updatedAt: '',
  markdown: '# hi'
};

test('loadPages / openPage / rotate / delete via api stubs [AC:lab-library-pages#AC-1]', async () => {
  const listed = await loadPages(async () => ({ pages: [{ ...sample }] }));
  assert.ok('pages' in listed && listed.pages[0]?.id === 'page_1');

  const opened = await openPage(async () => ({ page: sample }), 'page_1');
  assert.ok('page' in opened && opened.page.markdown === '# hi');

  const rotated = await rotatePageShare(async () => ({ page: { ...sample, shareId: 'share_b', sharePath: '/pages/share_b' } }), 'page_1');
  assert.ok('page' in rotated && rotated.page.sharePath === '/pages/share_b');

  const deleted = await deletePage(async () => ({}), 'page_1');
  assert.deepEqual(deleted, { ok: true });

  const copied = await copySharePath(async () => {}, '/pages/share_a');
  assert.deepEqual(copied, { ok: true });

  const rows = [{ ...sample }, { ...sample, id: 'page_2', shareId: 's2', sharePath: '/pages/s2' }];
  assert.equal(applyRotate(rows, { ...sample, shareId: 'share_z', sharePath: '/pages/share_z' })[0]?.sharePath, '/pages/share_z');
  assert.deepEqual(applyDelete(rows, 'page_1').map((r) => r.id), ['page_2']);
});

test('api failures return error strings [AC:lab-library-pages#AC-3]', async () => {
  const fail = async () => {
    throw new Error('boom');
  };
  assert.equal((await loadPages(fail) as { error: string }).error, 'boom');
  assert.equal((await openPage(fail, 'x') as { error: string }).error, 'boom');
  assert.equal((await rotatePageShare(fail, 'x') as { error: string }).error, 'boom');
  assert.equal((await deletePage(fail, 'x') as { error: string }).error, 'boom');
  assert.equal((await copySharePath(async () => { throw new Error('deny'); }, '/x') as { error: string }).error, 'deny');
});
