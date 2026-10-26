import assert from 'node:assert/strict';
import test from 'node:test';
import {
  botAvatarIssue,
  botAvatarValue,
  botCreateBlock,
  botCreateReady,
  buildBotCreatePayload,
  isBotAvatarEmoji,
  nextAvatarEmoji,
  unwrapCreatedBot
} from './bot-avatar.ts';

test('an empty icon keeps the generated face', () => {
  assert.equal(botAvatarValue('', '  '), null);
  assert.equal(botAvatarIssue('', ''), null);
});

test('a preset emoji is kept and an image URL wins when both are set', () => {
  assert.equal(isBotAvatarEmoji('🤖'), true);
  assert.equal(botAvatarValue('🤖', ''), '🤖');
  assert.equal(botAvatarIssue('🤖', ''), null);
  assert.equal(botAvatarValue('🤖', ' https://cdn.example/a.png '), 'https://cdn.example/a.png');
});

test('create payload omits blank optional fields and prefers the image', () => {
  assert.deepEqual(
    buildBotCreatePayload({
      name: '  Ada  ',
      title: '  ',
      description: '',
      emoji: '🤖',
      imageUrl: '',
      face: { shape: null, color: null }
    }),
    { name: 'Ada', avatar: '🤖' }
  );
  assert.deepEqual(
    buildBotCreatePayload({
      name: 'Ada',
      title: 'Helper',
      description: 'notes',
      emoji: '🤖',
      imageUrl: ' https://cdn.example/a.png ',
      face: { shape: 'bean', color: 'mint', style: 'soft', expression: 'wink' }
    }),
    {
      name: 'Ada',
      title: 'Helper',
      description: 'notes',
      faceShape: 'bean',
      faceColor: 'mint',
      faceStyle: 'soft',
      faceExpression: 'wink',
      avatar: 'https://cdn.example/a.png'
    }
  );
  assert.equal(buildBotCreatePayload({
    name: 'Ada', title: '', description: '', emoji: '🤖', imageUrl: '', face: { shape: 'star', color: null }
  }).faceShape, 'star');
  assert.equal(buildBotCreatePayload({
    name: 'Ada', title: '', description: '', emoji: '', imageUrl: '', face: { shape: null, color: null, style: 'classic' }
  }).faceStyle, undefined);
  assert.equal(buildBotCreatePayload({
    name: 'Ada', title: '', description: '', emoji: '', imageUrl: '', face: { shape: 'pebble', color: 'lilac', style: 'soft' }
  }).faceStyle, 'soft');
});

test('create form blocks on the first problem and unwraps either response shape', () => {
  assert.equal(botCreateBlock('empty', null), 'name-empty');
  assert.equal(botCreateBlock('taken', 'invalid'), 'name-taken');
  assert.equal(botCreateBlock(null, 'invalid'), 'avatar');
  assert.equal(botCreateBlock(null, null), null);
  assert.equal(botCreateReady(' Ada ', null, null, false), true);
  assert.equal(botCreateReady(' ', null, null, false), false);
  assert.equal(botCreateReady('Ada', 'taken', null, false), false);
  assert.equal(botCreateReady('Ada', null, 'invalid', false), false);
  assert.equal(botCreateReady('Ada', null, null, true), false);
  assert.equal(nextAvatarEmoji('🤖', '🤖'), '');
  assert.equal(nextAvatarEmoji('🤖', '✨'), '✨');
  const created = { id: 'ada' };
  assert.equal(unwrapCreatedBot({ bot: created }), created);
  assert.equal(unwrapCreatedBot(created), created);
  assert.deepEqual(unwrapCreatedBot({ bot: undefined }), { bot: undefined });
  assert.equal(unwrapCreatedBot(null), null);
});

test('only http(s) image URLs and short emoji are accepted', () => {
  assert.equal(botAvatarIssue('', 'ftp://cdn.example/a.png'), 'invalid');
  assert.equal(botAvatarIssue('', 'not a url'), 'invalid');
  assert.equal(botAvatarIssue('', 'https://cdn.example/a.png'), null);
  assert.equal(botAvatarIssue('a robot', ''), 'invalid');
  assert.equal(botAvatarIssue('x'.repeat(17), ''), 'invalid');
});
