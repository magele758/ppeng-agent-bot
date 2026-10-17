import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetedSpeakers, isRestrainedMember, restraintHint, scheduleRoomTurn, RESTRAINT_HINT } from '../src/rooms/scheduling.ts';

const alpha = 'bot_alpha';
const beta = 'bot_beta';
const gamma = 'bot_gamma';
const room = [alpha, beta, gamma];

test('mentioned members lead and the rest follow in room order [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, alpha]);
  assert.deepEqual(schedule.botIds, [beta, alpha, gamma]);
  assert.deepEqual(schedule.mentionedBotIds, [beta, alpha]);
});

test('a repeated mention is scheduled once, still first [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, beta, gamma]);
  assert.deepEqual(schedule.botIds, [beta, gamma, alpha]);
  assert.deepEqual(schedule.mentionedBotIds, [beta, gamma]);
});

test('no mention list schedules everyone and leaves mentionedBotIds unset [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, undefined);
  assert.deepEqual(schedule.botIds, room);
  assert.equal(schedule.mentionedBotIds, undefined);
  assert.notEqual(schedule.botIds, room);
});

test('an empty mention list schedules everyone and stores an empty named set [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, []);
  assert.deepEqual(schedule.botIds, room);
  assert.deepEqual(schedule.mentionedBotIds, []);
});

test('a name that is not a member is dropped and never scheduled [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, ['outsider', beta]);
  assert.deepEqual(schedule.botIds, [beta, alpha, gamma]);
  assert.deepEqual(schedule.mentionedBotIds, [beta]);
  assert.ok(!schedule.botIds.includes('outsider'));
});

test('only a member missing from mentionedBotIds is restrained [AC:bot-rooms#AC-2]', () => {
  const named = { mentionedBotIds: [beta] };
  assert.equal(isRestrainedMember(named, alpha), true);
  assert.equal(isRestrainedMember(named, beta), false);
  assert.equal(restraintHint(named, alpha), RESTRAINT_HINT);
  assert.equal(restraintHint(named, beta), '');
  assert.ok(RESTRAINT_HINT.includes('[SILENT]'));
  assert.ok(RESTRAINT_HINT.includes('not @-mentioned'));
});

test('a turn with no mentionedBotIds restrains nobody [AC:bot-rooms#AC-2]', () => {
  const open = {};
  assert.equal(isRestrainedMember(open, alpha), false);
  assert.equal(restraintHint(open, alpha), '');
});

test('an empty mentionedBotIds restrains every member [AC:bot-rooms#AC-2]', () => {
  const unmatched = { mentionedBotIds: [] };
  assert.equal(isRestrainedMember(unmatched, alpha), true);
  assert.equal(isRestrainedMember(unmatched, beta), true);
  assert.equal(restraintHint(unmatched, gamma), RESTRAINT_HINT);
});

test('the round budget keeps mentioned members and drops the rest [AC:bot-rooms#AC-2]', () => {
  const schedule = scheduleRoomTurn(room, [beta, alpha]);
  assert.deepEqual(budgetedSpeakers(schedule.botIds, 2), [beta, alpha]);
  assert.deepEqual(budgetedSpeakers(schedule.botIds, 1), [beta]);
  assert.deepEqual(budgetedSpeakers(schedule.botIds, 8), [beta, alpha, gamma]);
  assert.deepEqual(budgetedSpeakers(schedule.botIds, 0), []);
});
