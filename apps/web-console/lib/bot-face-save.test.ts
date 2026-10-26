import assert from 'node:assert/strict';
import test from 'node:test';
import { createFaceSaveQueue, facePatch, type FaceDraft } from './bot-face-save.ts';

const EMPTY: FaceDraft = {
  shape: null,
  color: null,
  style: null,
  softShape: null,
  softColor: null,
  softExpression: null
};

test('切换风格时带上当时的整套脸，单轴修改不带其它轴 [AC:bot-face-soft-style#AC-4]', () => {
  const soft: FaceDraft = { ...EMPTY, style: 'soft', softShape: 'pebble', softColor: 'lilac', softExpression: 'wink' };
  assert.deepEqual(facePatch('style', soft), {
    faceStyle: 'soft',
    faceShape: 'pebble',
    faceColor: 'lilac',
    faceExpression: 'wink'
  });
  assert.deepEqual(facePatch('style', { ...EMPTY, style: null, shape: 'star', color: 'red' }), {
    faceStyle: null,
    faceShape: 'star',
    faceColor: 'red',
    faceExpression: null
  });
  assert.deepEqual(facePatch('soft-shape', soft), { faceStyle: 'soft', faceShape: 'pebble' });
  assert.deepEqual(facePatch('shape', { ...EMPTY, shape: 'circle' }), { faceShape: 'circle', faceStyle: 'classic' });
});

test('后一次脸保存会等前一次结束，并带上等待期间已选的轮廓 [AC:bot-face-soft-style#AC-4]', async () => {
  let face: FaceDraft = { ...EMPTY, style: 'soft' };
  const save = createFaceSaveQueue(() => face);
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const first = save('style', async () => {
    order.push('style-start');
    await gate;
    order.push('style-end');
  });
  face = { ...face, softShape: 'capsule' };
  const second = save('soft-shape', async (patch) => {
    order.push('shape');
    assert.equal(patch().faceShape, 'capsule');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['style-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['style-start', 'style-end', 'shape']);
});

test('切换 Bot 后已入队的保存不再发出 [AC:bot-face-soft-style#AC-4]', async () => {
  let open = 'bot-a';
  const save = createFaceSaveQueue(() => EMPTY);
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sent: string[] = [];
  const clicked = 'bot-a';
  const first = save('style', async () => {
    await gate;
  });
  open = 'bot-b';
  const second = save('soft-shape', async () => {
    if (open !== clicked) return;
    sent.push(open);
  });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(sent, []);
});

test('同一队列在切换 Bot 后仍串行，慢的前一次不会与新队列并发 [AC:bot-face-soft-style#AC-4]', async () => {
  let open = 'bot-a';
  let face: FaceDraft = { ...EMPTY, style: 'soft', softShape: 'pebble' };
  const save = createFaceSaveQueue(() => face);
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];
  const bodies: Array<Record<string, string | null>> = [];
  const first = save('style', async (patch) => {
    const clicked = 'bot-a';
    started.push('first');
    if (open !== clicked) return;
    const body = patch();
    await gate;
    bodies.push(body);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first']);
  open = 'bot-b';
  face = { ...EMPTY, style: 'soft', softShape: 'capsule' };
  const second = save('soft-shape', async (patch) => {
    const clicked = 'bot-b';
    started.push('second');
    if (open !== clicked) return;
    bodies.push(patch());
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first']);
  assert.equal(bodies.length, 0);
  releaseFirst();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await second;
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.faceShape, 'pebble');
  assert.equal(bodies[1]?.faceShape, 'capsule');
});

test('Bloub edits preserve the selected style for every appearance axis [AC:bot-bloub-dynamic#AC-1]', () => {
  const face = { ...EMPTY, style: 'bloub', softShape: 'pebble', softColor: 'peach', softExpression: 'happy' };
  for (const kind of ['style', 'soft-shape', 'soft-color', 'soft-expression'] as const) {
    assert.equal(facePatch(kind, face).faceStyle, 'bloub');
  }
});
