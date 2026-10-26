import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBotFaceAppearance } from './bot-face.ts';
import {
  renderSoftBotFaceSvg,
  softBotFaceFromSeed,
  softBotFaceSeed,
  SOFT_BOT_COLORS,
  SOFT_BOT_EXPRESSIONS,
  SOFT_BOT_SILHOUETTES
} from './soft-bot-face.ts';

test('同一粒种子的软萌脸保持不变，不同种子可以不同 [AC:bot-face-soft-style#AC-2]', () => {
  const ada = softBotFaceFromSeed('bot_ada');
  assert.deepEqual(softBotFaceFromSeed('bot_ada'), ada);
  assert.deepEqual(softBotFaceFromSeed('bot_ada'), ada);
  assert.ok(SOFT_BOT_SILHOUETTES.includes(ada.silhouette));
  assert.ok(SOFT_BOT_COLORS.includes(ada.color));
  assert.ok(SOFT_BOT_EXPRESSIONS.includes(ada.expression));

  const seen = new Set<string>();
  for (const seed of ['bot_ada', 'bot_bea', 'bot_cio', 'bot_dee', 'bot_eli', 'Mira', 'Nia', 'Otto']) {
    const face = softBotFaceFromSeed(seed);
    seen.add(`${face.silhouette}:${face.color}:${face.expression}`);
  }
  assert.ok(seen.size >= 3, `expected several looks, got ${[...seen].join(', ')}`);

  const markup = renderSoftBotFaceSvg(ada);
  assert.equal(renderSoftBotFaceSvg(ada), markup);
  assert.match(markup, new RegExp(`data-soft-bot-face="${ada.silhouette}"`));
  assert.match(markup, /<path /);
  assert.doesNotMatch(markup, /<animate/);
});

test('指定轮廓或颜色时种子只填没选的那一项 [AC:bot-face-soft-style#AC-2]', () => {
  const picked = softBotFaceFromSeed('bot_ada', { silhouette: 'capsule', color: 'lilac' });
  assert.equal(picked.silhouette, 'capsule');
  assert.equal(picked.color, 'lilac');
  assert.equal(picked.expression, softBotFaceFromSeed('bot_ada').expression);
  const again = softBotFaceFromSeed('other', { silhouette: 'capsule', color: 'lilac', expression: 'wink' });
  assert.deepEqual(again, { silhouette: 'capsule', color: 'lilac', expression: 'wink' });
});

test('有 id 时用 id 做种子，否则用去掉空白的名字 [AC:bot-face-soft-style#AC-2]', () => {
  assert.equal(softBotFaceSeed({ id: ' bot_ada ', name: 'Ada' }), 'bot_ada');
  assert.equal(softBotFaceSeed({ id: '  ', name: '  Ada  ' }), 'Ada');
  assert.equal(softBotFaceSeed({ name: null }), '');
});

test('没保存风格或保存为经典时仍走原来的几何脸 [AC:bot-face-soft-style#AC-1]', () => {
  const named = resolveBotFaceAppearance({ name: 'DeskBot' });
  assert.equal(named.shape !== null && named.color !== null, true);
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot', savedShape: 'bean', savedColor: 'mint' }), {
    shape: 'bean',
    color: 'mint'
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: '', savedShape: null, savedColor: null }), {
    shape: null,
    color: null
  });
});
