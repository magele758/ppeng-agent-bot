import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageDetail,
  parsePageList,
  withRotatedShare,
  withoutPage
} from './library-pages-model.ts';

test('parsePageList keeps summaries and drops junk [AC:lab-library-pages#AC-1]', () => {
  const pages = parsePageList({
    pages: [
      {
        id: 'page_1',
        title: 'Hello',
        revision: 2,
        shareId: 'share_a',
        sharePath: '/pages/share_a',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      { id: 1 },
      null
    ]
  });
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.sharePath, '/pages/share_a');
  assert.equal('markdown' in pages[0]!, false);
});

test('parsePageDetail requires markdown body [AC:lab-library-pages#AC-2]', () => {
  assert.equal(parsePageDetail({ page: { id: 'page_1', title: 't', shareId: 's', sharePath: '/pages/s' } }), null);
  const page = parsePageDetail({
    page: {
      id: 'page_1',
      title: 't',
      revision: 1,
      shareId: 'share_a',
      sharePath: '/pages/share_a',
      markdown: '# hi',
      createdAt: '',
      updatedAt: ''
    }
  });
  assert.equal(page?.markdown, '# hi');
});

test('withoutPage and withRotatedShare update list rows [AC:lab-library-pages#AC-3]', () => {
  const rows = [
    { id: 'a', title: 'A', revision: 1, shareId: 's1', sharePath: '/pages/s1', createdAt: '', updatedAt: '' },
    { id: 'b', title: 'B', revision: 1, shareId: 's2', sharePath: '/pages/s2', createdAt: '', updatedAt: '' }
  ];
  assert.deepEqual(withoutPage(rows, 'a').map((r) => r.id), ['b']);
  const rotated = withRotatedShare(rows, { id: 'a', shareId: 's9', sharePath: '/pages/s9' });
  assert.equal(rotated[0]?.sharePath, '/pages/s9');
  assert.equal(rotated[1]?.sharePath, '/pages/s2');
});
