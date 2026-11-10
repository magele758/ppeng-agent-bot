import assert from 'node:assert/strict';
import test from 'node:test';
import {
  favoriteRequest,
  filterFavoriteSessions,
  groupSessionsWithFavorites,
  replaceSessionSummary,
  saveSessionFavorite,
  sessionIsFavorited,
  sessionListEmptyText,
  sessionsForSidebar,
  withSessionFavorite
} from './session-favorite.ts';

const NOW = Date.parse('2026-09-03T12:00:00+08:00');

function session(id: string, favorited?: boolean, updatedAt = '2026-09-03T08:00:00+08:00') {
  return {
    id,
    title: id,
    agentId: 'general',
    status: 'idle',
    mode: 'chat' as const,
    updatedAt,
    metadata: favorited === undefined ? {} : { favorited, note: 'keep' }
  };
}

test('一场会话点一次收藏后，列表能看出已收藏 [AC:session-favorite#AC-1]', async () => {
  const open = session('current');
  assert.equal(sessionIsFavorited(open), false);
  const calls: Array<{ path: string; body: string }> = [];
  const saved = await saveSessionFavorite(open, true, async (path, init) => {
    calls.push({ path, body: String(init.body) });
  });
  assert.equal(sessionIsFavorited(saved), true);
  assert.equal(saved.metadata?.note, undefined);
  assert.deepEqual(calls, [{ path: '/api/sessions/current', body: '{"favorited":true}' }]);
  const listed = [open].map((item) => replaceSessionSummary(item, 'current', () => saved));
  assert.equal(sessionIsFavorited(listed[0]), true);
  assert.equal(groupSessionsWithFavorites(listed, NOW)[0]?.bucket, 'favorites');
});

test('收藏的会话单独成组，只看收藏时其余不出现 [AC:session-favorite#AC-2]', () => {
  const saved = session('saved', true);
  const plain = session('plain', false, '2026-09-03T09:00:00+08:00');
  const older = session('older', false, '2026-09-02T09:00:00+08:00');
  const groups = groupSessionsWithFavorites([plain, saved, older], NOW);
  assert.equal(groups[0]?.bucket, 'favorites');
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id), ['saved']);
  const rest = groups.slice(1).flatMap((group) => group.sessions.map((item) => item.id));
  assert.deepEqual(rest.sort(), ['older', 'plain']);
  assert.ok(groups.slice(1).every((group) => group.bucket !== 'favorites'));
  const only = sessionsForSidebar([saved, plain, older], '', true);
  assert.deepEqual(only.map((item) => item.id), ['saved']);
  assert.deepEqual(filterFavoriteSessions([saved, plain], false).map((item) => item.id), ['saved', 'plain']);
  assert.equal(sessionListEmptyText({ botSurface: false, favoritesOnly: true }, {
    noBots: '无 Bot',
    noSessions: '无会话',
    noFavorites: '没有收藏的会话'
  }), '没有收藏的会话');
  assert.equal(sessionListEmptyText({ botSurface: false, favoritesOnly: false }, {
    noBots: '无 Bot',
    noSessions: '无会话',
    noFavorites: '没有收藏的会话'
  }), '无会话');
});

test('再点一次就取消收藏，只看收藏时找不到 [AC:session-favorite#AC-3]', async () => {
  const saved = session('saved', true);
  assert.equal(sessionIsFavorited(saved), true);
  const cleared = await saveSessionFavorite(saved, false, async () => undefined);
  assert.equal(sessionIsFavorited(cleared), false);
  assert.equal(cleared.metadata?.note, 'keep');
  assert.equal(favoriteRequest('saved', false).init.body, '{"favorited":false}');
  const groups = groupSessionsWithFavorites([cleared], NOW);
  assert.ok(groups.every((group) => group.bucket !== 'favorites'));
  assert.deepEqual(groups.flatMap((group) => group.sessions.map((item) => item.id)), ['saved']);
  assert.deepEqual(sessionsForSidebar([cleared], '', true), []);
});

test('列表替换只改被收藏的那一场 [AC:session-favorite#AC-1]', () => {
  const first = session('a');
  const second = session('b', true);
  const next = [first, second].map((item) => replaceSessionSummary(item, 'a', (current) => withSessionFavorite(current, true)));
  assert.equal(sessionIsFavorited(next[0]), true);
  assert.equal(next[1], second);
});
