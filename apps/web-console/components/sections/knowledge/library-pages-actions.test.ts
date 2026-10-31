import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCreate,
  applyDelete,
  applyRotate,
  applyUpdate,
  copySharePath,
  createPage,
  deletePage,
  getRevision,
  listRevisions,
  loadPages,
  openPage,
  restoreRevision,
  rotatePageShare,
  updatePage
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

test('createPage / updatePage via api stubs [AC:lab-library-pages#AC-create]', async () => {
  const created = await createPage(async () => ({ page: { ...sample, id: 'page_new', revision: 1 } }), 'New Page', '# New');
  assert.ok('page' in created && created.page.id === 'page_new');
  assert.equal(created.page.markdown, '# hi');

  const updated = await updatePage(
    async () => ({ page: { ...sample, title: 'Updated', markdown: '# Updated' } }),
    'page_1',
    { title: 'Updated', markdown: '# Updated' }
  );
  assert.ok('page' in updated && updated.page.title === 'Updated');
});

test('createPage / updatePage failures return error strings [AC:lab-library-pages#AC-edit]', async () => {
  const fail = async () => {
    throw new Error('api error');
  };
  assert.equal((await createPage(fail, 'Title', 'body') as { error: string }).error, 'api error');
  assert.equal((await updatePage(fail, 'x', { title: 'T' }) as { error: string }).error, 'api error');
});

test('applyCreate adds to front; applyUpdate modifies row [AC:lab-library-pages#AC-create][AC:lab-library-pages#AC-edit]', () => {
  const rows = [{ ...sample }];
  const newPage = { ...sample, id: 'page_2', title: 'New' };
  const created = applyCreate(rows, newPage);
  assert.equal(created[0]?.id, 'page_2');
  assert.equal(created[1]?.id, 'page_1');

  const updated = applyUpdate(rows, { ...sample, title: 'Changed' });
  assert.equal(updated[0]?.title, 'Changed');
});

test('list/get/restore revisions via api stubs [AC:lab-library-pages#AC-rev] [AC:page-revisions#AC-lab]', async () => {
  const listed = await listRevisions(async () => ({ revisions: [{ revision: 1, createdAt: 't', title: 'T' }] }), 'page_1');
  assert.ok('revisions' in listed && listed.revisions[0]?.revision === 1);

  const got = await getRevision(
    async () => ({ revision: { pageId: 'page_1', revision: 1, title: 'T', markdown: '# hi', createdAt: 't' } }),
    'page_1',
    1
  );
  assert.ok('revision' in got && got.revision.markdown === '# hi');

  const restored = await restoreRevision(async () => ({ page: { ...sample, revision: 3, markdown: '# hi' } }), 'page_1', 1);
  assert.ok('page' in restored && restored.page.revision === 3);

  const fail = async () => {
    throw new Error('boom');
  };
  assert.equal((await listRevisions(fail, 'x') as { error: string }).error, 'boom');
  assert.equal((await getRevision(fail, 'x', 1) as { error: string }).error, 'boom');
  assert.equal((await restoreRevision(fail, 'x', 1) as { error: string }).error, 'boom');
});

