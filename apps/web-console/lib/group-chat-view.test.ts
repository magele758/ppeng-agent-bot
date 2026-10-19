import test from 'node:test';
import assert from 'node:assert/strict';
import { groupComposerCommand, groupMessageMood, roomComposerDisabled, roomDefaultModelLabel, roomHistoryUrl, roomMemberModelLabel, runGroupComposerCommand } from './group-chat-view.ts';
import type { RoomModelConfiguration } from './room-models';

const model = { providerId: 'local', providerName: 'Local', modelId: 'chat' };
const models: RoomModelConfiguration = { defaultModel: model, members: [
  { botId: 'inherited', model, source: 'global' },
  { botId: 'pinned', model: { ...model, modelId: 'special' }, source: 'bot' },
  { botId: 'missing', model: null, source: 'unconfigured' }
] };
const t = (key: string) => key;

test('room labels distinguish loading, missing configuration, pinned and global models', () => {
  assert.equal(roomDefaultModelLabel(null, t), 'common.loading');
  assert.equal(roomDefaultModelLabel({ ...models, defaultModel: null }, t), 'play.groupModel.unconfigured');
  assert.equal(roomDefaultModelLabel(models, t), 'Local / chat');
  assert.equal(roomMemberModelLabel(null, 'inherited', t), 'common.loading');
  assert.equal(roomMemberModelLabel(models, 'inherited', t), 'play.groupModel.globalSource · Local / chat');
  assert.equal(roomMemberModelLabel(models, 'pinned', t), 'play.groupModel.botSource · Local / special');
  for (const id of ['missing', 'unknown']) assert.equal(roomMemberModelLabel(models, id, t), 'play.groupModel.unconfigured');
});

test('room history sends a cursor only for an explicitly requested older page', () => {
  assert.equal(roomHistoryUrl('room', false, 42), '/api/bot-rooms/room/messages?limit=50');
  assert.equal(roomHistoryUrl('room', true, null), '/api/bot-rooms/room/messages?limit=50');
  assert.equal(roomHistoryUrl('room', true, 42), '/api/bot-rooms/room/messages?limit=50&beforeSeq=42');
});

test('room composer cannot submit a paused, missing, busy or blank conversation', () => {
  assert.equal(roomComposerDisabled(null, false, 'hello'), true);
  assert.equal(roomComposerDisabled({ status: 'active' }, true, 'hello'), true);
  assert.equal(roomComposerDisabled({ status: 'paused' }, false, 'hello'), true);
  assert.equal(roomComposerDisabled({ status: 'active' }, false, '  '), true);
  assert.equal(roomComposerDisabled({ status: 'active' }, false, '  ', true), false);
  assert.equal(roomComposerDisabled({ status: 'active' }, false, 'hello'), false);
});

test('mention navigation and IME preserve compose behavior without accidentally sending', () => {
  assert.equal(groupComposerCommand('ArrowDown', false, false, true, 2, true), 'next');
  assert.equal(groupComposerCommand('ArrowUp', false, false, true, 2, true), 'previous');
  assert.equal(groupComposerCommand('Escape', false, false, true, 0, false), 'dismiss');
  assert.equal(groupComposerCommand('Enter', false, false, true, 2, true), 'choose');
  assert.equal(groupComposerCommand('Enter', false, false, true, 0, false), 'send');
  assert.equal(groupComposerCommand('Enter', false, false, false, 2, true), 'send');
  for (const [key, shift, composing, open, count] of [
    ['ArrowDown', false, false, true, 0], ['ArrowUp', false, false, true, 0],
    ['ArrowUp', false, false, false, 2], ['Escape', false, false, false, 0],
    ['Enter', true, false, true, 2], ['Enter', false, true, true, 2], ['a', false, false, false, 0]
  ] as const) assert.equal(groupComposerCommand(key, shift, composing, open, count, true), 'none');
  const calls: string[] = [];
  const actions = { next: () => calls.push('next'), previous: () => calls.push('previous'), dismiss: () => calls.push('dismiss'), choose: () => calls.push('choose'), send: () => calls.push('send') };
  for (const command of ['none', 'next', 'previous', 'dismiss', 'choose', 'send'] as const) runGroupComposerCommand(command, actions);
  assert.deepEqual(calls, ['next', 'previous', 'dismiss', 'choose', 'send']);
});

test('only the final live message of a currently working bot speaks', () => {
  const message = { id: 'latest', sender: { type: 'bot', id: 'one' } };
  assert.equal(groupMessageMood(message, 'latest', { one: 2 }), 'speaking');
  assert.equal(groupMessageMood(message, 'latest', { one: 0 }), 'idle');
  assert.equal(groupMessageMood(message, 'old', { one: 2 }), 'idle');
  assert.equal(groupMessageMood({ ...message, sender: { type: 'user', id: 'one' } }, 'latest', { one: 2 }), 'idle');
  assert.equal(groupMessageMood(message, undefined, {}), 'idle');
});
