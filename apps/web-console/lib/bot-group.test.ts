import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeMentionQuery,
  addGroupMember,
  filterMentionMembers,
  groupMatchesQuery,
  groupMemberIds,
  groupSpeakBudget,
  insertMention,
  removeGroupMember
} from './bot-group.ts';

test('rejects a group with fewer than two bots [AC:play-bot-group#AC-1]', () => {
  assert.deepEqual(groupMemberIds([]), { ok: false, code: 'need_two' });
  assert.deepEqual(groupMemberIds(['super-bot']), { ok: false, code: 'need_two' });
  assert.deepEqual(groupMemberIds(['  ']), { ok: false, code: 'blank' });
});

test('rejects duplicate bot members instead of dropping them [AC:play-bot-group#AC-1]', () => {
  const duplicated = groupMemberIds(['super-bot', 'deskbot', 'super-bot']);
  assert.deepEqual(duplicated, { ok: false, code: 'duplicate' });
  assert.deepEqual(groupMemberIds(['xiaoba', 'xiaoba']), { ok: false, code: 'duplicate' });
});

test('accepts two or more distinct bots [AC:play-bot-group#AC-1]', () => {
  assert.deepEqual(groupMemberIds(['super-bot', 'xiaoba']), {
    ok: true,
    members: ['super-bot', 'xiaoba']
  });
  assert.deepEqual(groupMemberIds([' super-bot ', 'deskbot', 'xiaoba'], new Set(['super-bot', 'deskbot', 'xiaoba'])), {
    ok: true,
    members: ['super-bot', 'deskbot', 'xiaoba']
  });
  assert.deepEqual(groupMemberIds(['super-bot', 'missing'], new Set(['super-bot'])), {
    ok: false,
    code: 'unknown'
  });
});

test('rejects adding a bot that is already a member [AC:play-bot-group#AC-2]', () => {
  assert.deepEqual(addGroupMember(['super-bot', 'xiaoba'], 'xiaoba'), { ok: false, code: 'duplicate' });
  assert.deepEqual(addGroupMember(['super-bot', 'xiaoba'], '  '), { ok: false, code: 'blank' });
  assert.deepEqual(addGroupMember(['super-bot', 'xiaoba'], 'deskbot', new Set(['super-bot', 'xiaoba'])), {
    ok: false,
    code: 'unknown'
  });
  assert.deepEqual(addGroupMember(['super-bot', 'xiaoba'], 'deskbot', new Set(['super-bot', 'xiaoba', 'deskbot'])), {
    ok: true,
    members: ['super-bot', 'xiaoba', 'deskbot']
  });
});

test('rejects removing a member when fewer than two would remain [AC:play-bot-group#AC-2]', () => {
  assert.deepEqual(removeGroupMember(['super-bot', 'xiaoba'], 'xiaoba'), { ok: false, code: 'need_two' });
  assert.deepEqual(removeGroupMember(['super-bot'], 'super-bot'), { ok: false, code: 'need_two' });
  assert.deepEqual(removeGroupMember(['super-bot', 'xiaoba', 'deskbot'], 'xiaoba'), {
    ok: true,
    members: ['super-bot', 'deskbot']
  });
});

test('speak budget covers every member up to the room cap', () => {
  assert.equal(groupSpeakBudget(2), 2);
  assert.equal(groupSpeakBudget(8), 8);
  assert.equal(groupSpeakBudget(50), 20);
  assert.equal(groupSpeakBudget(1), 2);
});

test('typing @ opens a member query and choosing one inserts @name', () => {
  const members = [{ name: 'Super Bot' }, { name: '小八' }, { name: 'DeskBot' }];
  assert.equal(activeMentionQuery('hello', 5), null);
  assert.deepEqual(activeMentionQuery('hi @', 4), { start: 3, query: '' });
  assert.deepEqual(activeMentionQuery('hi @小', 5), { start: 3, query: '小' });
  assert.equal(activeMentionQuery('mail owner@example.com', 20), null);
  assert.equal(activeMentionQuery('hi @小八 ', 7), null);
  assert.deepEqual(
    filterMentionMembers(members, '小').map((member) => member.name),
    ['小八']
  );
  assert.deepEqual(
    filterMentionMembers(members, '').map((member) => member.name),
    ['Super Bot', '小八', 'DeskBot']
  );
  assert.deepEqual(insertMention('hi @小', 3, 5, '小八'), { value: 'hi @小八 ', caret: 7 });
});

test('sidebar filter matches a group title or member without treating it as one bot', () => {
  const room = { title: '值班小组', botIds: ['super-bot', 'xiaoba'] };
  const nameOf = (id: string) => (id === 'xiaoba' ? '小八' : id);
  assert.equal(groupMatchesQuery(room, '', nameOf), true);
  assert.equal(groupMatchesQuery(room, '值班', nameOf), true);
  assert.equal(groupMatchesQuery(room, '小八', nameOf), true);
  assert.equal(groupMatchesQuery(room, 'deskbot', nameOf), false);
});
