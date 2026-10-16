import assert from 'node:assert/strict';
import test from 'node:test';
import { botAvatarIssue, botAvatarValue, isBotAvatarEmoji } from './bot-avatar.ts';

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

test('only http(s) image URLs and short emoji are accepted', () => {
  assert.equal(botAvatarIssue('', 'ftp://cdn.example/a.png'), 'invalid');
  assert.equal(botAvatarIssue('', 'not a url'), 'invalid');
  assert.equal(botAvatarIssue('', 'https://cdn.example/a.png'), null);
  assert.equal(botAvatarIssue('a robot', ''), 'invalid');
  assert.equal(botAvatarIssue('x'.repeat(17), ''), 'invalid');
});
