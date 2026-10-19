import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionPanelResource, transcriptModelView } from './session-panel-resource.ts';

test('late panel resource success and failure cannot repaint another session [AC:bot-switch-live-turn#AC-4]', async () => {
 for (const fail of [false, true]) {
  let finish!: () => void;
  let current = true;
  const applied: string[] = [];
  const pending = new Promise<string>((resolve, reject) => { finish = () => fail ? reject(Error('old')) : resolve('old'); });
  const load = loadSessionPanelResource(() => pending, () => current, value => applied.push(value), 'fallback');
  current = false; finish(); await load;
  assert.deepEqual(applied, []);
 }
 const applied: string[] = [];
 await loadSessionPanelResource(async () => 'fresh', () => true, value => applied.push(value), 'fallback');
 await loadSessionPanelResource(async () => { throw Error('current'); }, () => true, value => applied.push(value), 'fallback');
 assert.deepEqual(applied, ['fresh', 'fallback']);
 assert.deepEqual(transcriptModelView(false, true, ['old'], []), []);
 assert.deepEqual(transcriptModelView(true, true, ['fresh'], ['history']), ['fresh']);
 assert.deepEqual(transcriptModelView(true, false, ['fresh'], ['history']), ['history']);
});

test('history pagination requires the loaded transcript owner [AC:bot-switch-live-turn#AC-4]', async () => {
 const { canRequestOlderPage, pageEpochCurrent } = await import('./feed-window.ts');
 const input = { sessionId: 'b', cursor: 20, loading: false, reason: 'scroll' as const, blocked: false };
 assert.equal(canRequestOlderPage({ ...input, loadedSessionId: 'a' }), false);
 assert.equal(canRequestOlderPage({ ...input, loadedSessionId: 'b' }), true);
 assert.equal(pageEpochCurrent('b', 'b', 2, 2, 'a'), false);
 assert.equal(pageEpochCurrent('b', 'b', 2, 2, 'b'), true);
});
