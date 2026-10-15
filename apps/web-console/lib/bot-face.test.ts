import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_FACE_COUNT, botFaceIndex } from './bot-face.ts';

test('同一个名字始终对应同一张脸 [AC:bot-robot-faces#AC-1] [AC:bot-robot-faces#AC-2] [AC:bot-robot-faces#AC-3]', () => {
  assert.equal(BOT_FACE_COUNT, 8);
  assert.equal(botFaceIndex('Researcher'), 2);
  assert.equal(botFaceIndex('Researcher'), botFaceIndex('Researcher'));
  assert.equal(botFaceIndex('  Ada  '), 6);
  assert.equal(botFaceIndex('Ada'), 6);
  assert.equal(botFaceIndex('ada'), 4);
  assert.notEqual(botFaceIndex('Ada'), botFaceIndex('ada'));
  assert.equal(botFaceIndex('Beta'), 7);
  assert.equal(botFaceIndex('每日简报'), 2);
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo']) {
    const index = botFaceIndex(name);
    assert.equal(index, botFaceIndex(name));
    assert.ok(index !== null && index >= 0 && index < BOT_FACE_COUNT);
  }
  const used = new Set(
    ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kay', 'Lima'].map(
      (name) => botFaceIndex(name)
    )
  );
  assert.ok(used.size > 1);
});

test('没有名字时使用占位脸 [AC:bot-robot-faces#AC-4]', () => {
  assert.equal(botFaceIndex(''), null);
  assert.equal(botFaceIndex('   '), null);
  assert.equal(botFaceIndex(null), null);
  assert.equal(botFaceIndex(undefined), null);
});
