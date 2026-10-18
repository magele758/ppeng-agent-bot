import test from 'node:test';
import assert from 'node:assert/strict';
import { canMoveBot, factEditorState, functionalGroupPresentation, functionalGroupRows, functionalGroupSaveRequest, groupForBot, groupSaveDisabled, moveBotInGroups, upsertFunctionalGroup } from './functional-group-view.ts';
import type { BotInfo, SessionSummary } from './types';

const bots = [{ id: 'one', name: 'One', canonicalSessionId: 's1' }, { id: 'two', name: 'Two', canonicalSessionId: 's2' }, { id: 'hidden', name: 'Hidden', canonicalSessionId: 's3', hidden: true }] as BotInfo[];
const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 'personal', metadata: { botId: 'one', canonicalBotChat: true } }, { id: 'other' }] as SessionSummary[];
const groups = [{ id: 'a', name: 'A', botIds: ['one'] }, { id: 'b', name: 'B', botIds: [] }];

test('functional group rows respect hidden bots and per-user canonical sessions', () => {
  assert.deepEqual(functionalGroupRows(groups, bots, sessions, 'a').map(s => s.id), ['s1', 'personal']);
  assert.deepEqual(functionalGroupRows(groups, bots, sessions, null).map(s => s.id), ['s2', 'other']);
  assert.deepEqual(functionalGroupRows(groups, bots, sessions, 'b'), []);
  assert.equal(groupForBot(groups, 'unknown'), null);
});

test('moving a bot guards unknown, busy and no-op moves and preserves rollback snapshot', () => {
  assert.equal(canMoveBot(groups, bots, true, 'one', 'b'), false);
  assert.equal(canMoveBot(groups, bots, false, 'unknown', 'b'), false);
  assert.equal(canMoveBot(groups, bots, false, 'one', 'a'), false);
  assert.equal(canMoveBot(groups, bots, false, 'two', null), false);
  assert.equal(canMoveBot(groups, bots, false, 'one', 'b'), true);
  const next = moveBotInGroups(groups, 'one', 'b');
  assert.deepEqual(next.map(g => g.botIds), [[], ['one']]);
  assert.deepEqual(groups.map(g => g.botIds), [['one'], []], 'original snapshot is unchanged for failed requests');
  assert.deepEqual(moveBotInGroups(next, 'one', null).map(g => g.botIds), [[], []]);
  assert.deepEqual(moveBotInGroups(next, 'one', 'b').map(g => g.botIds), [[], ['one']], 'never duplicates a member');
});

test('group save requests trim names and update by returned identity', () => {
  const created = { id: 'c', name: 'C', botIds: [] };
  assert.deepEqual(upsertFunctionalGroup(groups, created), [...groups, created]);
  const renamed = { ...groups[0], name: 'Renamed' };
  assert.deepEqual(upsertFunctionalGroup(groups, renamed), [renamed, groups[1]]);
  assert.deepEqual(functionalGroupSaveRequest({ name: ' New ' }), { path: '/api/bot-functional-groups', options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"New"}' } });
  const update = functionalGroupSaveRequest({ id: 'a/b', name: ' New ' });
  assert.equal(update.path, '/api/bot-functional-groups/a%2Fb');
  assert.equal(update.options.method, 'PATCH');
  assert.equal(groupSaveDisabled(null, false), true);
  assert.equal(groupSaveDisabled({ name: '  ' }, false), true);
  assert.equal(groupSaveDisabled({ name: 'New' }, true), true);
  assert.equal(groupSaveDisabled({ name: 'New' }, false), false);
});

test('shared fact controls reject empty or duplicate trimmed keys and wait for the requested scope', () => {
  assert.deepEqual(factEditorState([], false, true), { disabled: false, saveDisabled: false }, 'can explicitly clear all entries');
  assert.deepEqual(factEditorState([{ key: ' Key ', value: 'hello' }], false, true), { disabled: false, saveDisabled: false });
  assert.equal(factEditorState([{ key: ' ', value: '' }], false, true).saveDisabled, true);
  assert.equal(factEditorState([{ key: ' x ', value: 'a' }, { key: 'x', value: 'b' }], false, true).saveDisabled, true);
  assert.deepEqual(factEditorState([], true, true), { disabled: true, saveDisabled: true });
  assert.deepEqual(factEditorState([], false, false), { disabled: true, saveDisabled: true });
});

test('ungrouped sections use stable droppable identity and localized name', () => {
  assert.deepEqual(functionalGroupPresentation(null, 'Unassigned'), { id: null, key: 'ungrouped', name: 'Unassigned' });
  assert.deepEqual(functionalGroupPresentation(groups[0], 'Unassigned'), { id: 'a', key: 'a', name: 'A' });
});
