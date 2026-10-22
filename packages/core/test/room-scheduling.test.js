import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetedSpeakers, scheduleRoomTurn } from '../dist/rooms/scheduling.js';

const alpha = 'bot_alpha';
const beta = 'bot_beta';
const gamma = 'bot_gamma';
const room = [alpha, beta, gamma];

test('a mention schedules only the named members, in order [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, alpha], { hostBotId: alpha, maxSpeakers: 4 });
  assert.deepEqual(schedule.botIds, [beta, alpha]);
  assert.deepEqual(schedule.mentionedBotIds, [beta, alpha]);
  assert.ok(!schedule.botIds.includes(gamma));
});

test('a repeated mention is scheduled once [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, beta, gamma]);
  assert.deepEqual(schedule.botIds, [beta, gamma]);
  assert.deepEqual(schedule.mentionedBotIds, [beta, gamma]);
  assert.ok(!schedule.botIds.includes(alpha));
});

test('no mention with no overlap schedules nobody [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-4] [AC:bot-room-speaker-pick#AC-5]', () => {
  const cards = room.map(id => ({ id, name: id, title: id, description: '', groupName: '' }));
  const schedule = scheduleRoomTurn(room, undefined, { hostBotId: beta, message: 'ordinary question', cards });
  assert.deepEqual(schedule.botIds, []);
  assert.equal(schedule.mentionedBotIds, undefined);
});

test('no mention schedules overlapping members within the cap [AC:bot-room-speaker-pick#AC-1] [AC:bot-room-speaker-pick#AC-2] [AC:bot-room-sparse-routing#AC-4]', () => {
  const cards = [
    { id: alpha, name: 'Alpha', title: 'Alpha', description: '', groupName: '' },
    { id: beta, name: 'Beta', title: '证书管理员', description: '负责集群证书续期', groupName: '' },
    { id: gamma, name: 'Gamma', title: 'Gamma', description: '', groupName: '' }
  ];
  const schedule = scheduleRoomTurn(room, undefined, { hostBotId: alpha, maxSpeakers: 4, message: '证书怎么续期', cards });
  assert.deepEqual(schedule.botIds, [beta]);
  assert.equal(schedule.mentionedBotIds, undefined);
  assert.ok((schedule.speakerScores ?? []).some(item => item.id === alpha && item.score < 2));
});

test('an empty mention list schedules nobody [AC:bot-rooms#AC-2] [AC:bot-room-sparse-routing#AC-3]', () => {
  const schedule = scheduleRoomTurn(room, []);
  assert.deepEqual(schedule.botIds, []);
  assert.deepEqual(schedule.mentionedBotIds, []);
});

test('a name that is not a member is dropped and does not pull in everyone else [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, ['outsider', beta]);
  assert.deepEqual(schedule.botIds, [beta]);
  assert.deepEqual(schedule.mentionedBotIds, [beta]);
});

test('the per-round cap keeps the earliest names [AC:bot-room-sparse-routing#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, alpha, gamma], { maxSpeakers: 1 });
  assert.deepEqual(schedule.botIds, [beta]);
  assert.deepEqual(schedule.mentionedBotIds, [beta, alpha, gamma]);
  assert.deepEqual(budgetedSpeakers(schedule.botIds, 8), [beta]);
});
