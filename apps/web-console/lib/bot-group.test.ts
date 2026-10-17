import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeMentionQuery,
  addGroupMember,
  filterMentionMembers,
  groupMatchesQuery,
  groupCreateBlock,
  groupCreateBlockKey,
  groupCreateDraft,
  groupCreateError,
  groupCreateNeedsRoster,
  groupCreateReady,
  buildBotGroupCreateBody,
  groupMemberIds,
  groupSpeakBudget,
  groupTitleOk,
  toggleGroupMember,
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

test('a group title is one to 120 trimmed characters', () => {
  assert.equal(groupTitleOk('  '), false);
  assert.equal(groupTitleOk('值班'), true);
  assert.equal(groupTitleOk('x'.repeat(120)), true);
  assert.equal(groupTitleOk(` ${'x'.repeat(121)} `), false);
});

test('toggling membership adds then removes an id', () => {
  assert.deepEqual(toggleGroupMember([], 'ada'), ['ada']);
  assert.deepEqual(toggleGroupMember(['ada', 'bob'], 'bob'), ['ada']);
  assert.deepEqual(toggleGroupMember(['ada'], 'bob'), ['ada', 'bob']);
});

test('group create body hosts the first member and stops on a bad title or roster', () => {
  const known = new Set(['ada', 'bob', 'cy']);
  assert.equal(groupCreateNeedsRoster(1), true);
  assert.equal(groupCreateNeedsRoster(2), false);
  assert.equal(buildBotGroupCreateBody('  ', ['ada', 'bob'], known), null);
  assert.equal(buildBotGroupCreateBody('值班', ['ada'], known), null);
  assert.deepEqual(buildBotGroupCreateBody(' 值班 ', ['ada', 'bob', 'cy'], known), {
    title: '值班',
    botIds: ['ada', 'bob', 'cy'],
    hostBotId: 'ada',
    maxBotTurns: 3
  });
  assert.equal(groupCreateReady('值班', ['ada', 'bob'], known), true);
  assert.equal(groupCreateReady('值班', ['ada'], known), false);
  assert.equal(groupCreateBlock(false, true), 'title');
  assert.equal(groupCreateBlock(true, false), 'members');
  assert.equal(groupCreateBlock(true, true), null);
  assert.equal(groupCreateBlockKey('title', true), 'play.group.titleInvalid');
  assert.equal(groupCreateBlockKey('members', true), 'agents.bots.groupNeedTwo');
  assert.equal(groupCreateBlockKey(null, false), 'agents.bots.groupNeedTwo');
  assert.equal(groupCreateBlockKey(null, true), null);
  const short = groupCreateDraft('值班', ['ada'], known);
  assert.equal(short.ready, false);
  assert.equal(short.body, null);
  assert.equal(short.warnMembers, true);
  assert.equal(short.blockKey, 'agents.bots.groupNeedTwo');
  const blank = groupCreateDraft('  ', [], known);
  assert.equal(blank.block, 'title');
  assert.equal(blank.warnMembers, false);
  assert.equal(blank.blockKey, 'play.group.titleInvalid');
  const titled = groupCreateDraft('  ', ['ada', 'bob'], known);
  assert.equal(titled.block, 'title');
  assert.equal(titled.blockKey, 'play.group.titleInvalid');
  const ready = groupCreateDraft('值班', ['ada', 'bob'], known);
  assert.equal(ready.blockKey, null);
  assert.equal(ready.body?.hostBotId, 'ada');
  assert.equal(groupCreateError(new Error('nope'), (message) => `failed:${message}`), 'failed:nope');
  assert.equal(groupCreateError('down', (message) => `failed:${message}`), 'failed:down');
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
