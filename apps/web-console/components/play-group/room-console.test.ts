import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from '../../lib/i18n/messages/en/index.ts';
import { zh } from '../../lib/i18n/messages/zh/index.ts';
import {
  groupCanAdd,
  groupRemovalPlan,
  memberDrawer,
  memberNeedsPerson,
  mentionChoices,
  normalizeFunctionalGroups,
  readRoomGoal,
  roomApprovalMode,
  showInlineApprove,
  speakingBotIds,
  tileMembersInHeader,
  uniqueMemberIds,
  type RoomBot
} from './room-console.ts';

const chat = readFileSync(new URL('./PlayBotGroupChat.tsx', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('./RoomMemberDrawer.tsx', import.meta.url), 'utf8');
const goalBar = readFileSync(new URL('./RoomGoalBar.tsx', import.meta.url), 'utf8');
const capacity = readFileSync(new URL('../RoomCapacitySettingsCard.tsx', import.meta.url), 'utf8');
const general = readFileSync(new URL('../sections/settings/categories/general.tsx', import.meta.url), 'utf8');

const orion: RoomBot = { id: 'orion', name: 'Orion', title: 'DBA', description: '数据库专家' };
const ada: RoomBot = { id: 'ada', name: 'Ada', title: 'Ada', description: '架构' };
const bots: RoomBot[] = [ada, orion, { id: 'c', name: 'Cee' }, { id: 'd', name: 'Dee' }, { id: 'e', name: 'Ee' }, { id: 'f', name: 'Eff' }, { id: 'g', name: 'Gee' }];
const groups = [
  { id: 'arch', name: '架构组', botIds: ['ada', 'c'] },
  { id: 'data', name: '数据组', botIds: ['orion'] }
];

test('成员卡不铺职责长文，标题栏只留短的模型设置入口 [AC:group-member-quiet#AC-1] [AC:group-member-quiet#AC-4] [AC:group-member-quiet#AC-5] [AC:global-default-model-clarity#AC-4] [AC:global-default-model-clarity#AC-5]', () => {
  assert.doesNotMatch(chat, /descriptionOf|play-group-member__desc|play\.groupModel\.priorityHint|play\.groupModel\.defaultLabel|play-group-model-hint|play\.groupModel\.unconfigured/);
  assert.doesNotMatch(chat, /全局默认模型|这里展示普通文本模型配置|Bot 专属|全局默认/);
  assert.doesNotMatch(drawer, /play-group-member__desc/);
  assert.match(chat, /href="#\/settings\/models"/);
  assert.match(chat, /data-testid="room-default-model"/);
  assert.match(chat, /play\.groupModel\.settings/);
  assert.match(chat, /RoomSharedContextEditor/);
  assert.match(chat, /onAddMember=\{\(botId\) => void addMember\(botId\)\}/);
  assert.match(chat, /onRemoveMember=\{\(botId\) => void removeMember\(botId\)\}/);
  assert.match(drawer, /t\('play\.group\.add'\)/);
  assert.match(drawer, /room-member-model-/);
  assert.equal(zh.play.groupModel.settings, '默认模型');
  assert.equal(en.play.groupModel.settings, 'Default model');
  assert.equal('priorityHint' in zh.play.groupModel, false);
  assert.equal('defaultLabel' in zh.play.groupModel, false);
  assert.equal('priorityHint' in en.play.groupModel, false);
  assert.equal('defaultLabel' in en.play.groupModel, false);
});

test('超过 6 人时主聊天区不铺成员卡，打开后可搜索并整组加入或移出 [AC:bot-room-console#AC-1]', () => {
  assert.equal(tileMembersInHeader(6), true);
  assert.equal(tileMembersInHeader(7), false);
  assert.deepEqual(uniqueMemberIds(['ada', 'ada', 'orion']), ['ada', 'orion']);
  assert.deepEqual(groupRemovalPlan(['ada', 'orion', 'c'], ['c']), { ok: true, remove: ['c'], next: ['ada', 'orion'] });
  const blocked = groupRemovalPlan(['ada', 'orion', 'c'], ['orion', 'c']);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'need_two');
  assert.equal(groupCanAdd(['ada'], ['ada', 'orion'], new Set(['ada', 'orion'])), true);
  assert.equal(groupCanAdd(['ada', 'orion'], ['ada', 'orion'], new Set(['ada', 'orion'])), false);

  const view = memberDrawer({
    memberIds: bots.map((bot) => bot.id).filter((id) => id !== 'orion'),
    bots,
    groups,
    hostId: 'ada',
    speakingIds: ['ada'],
    query: '数据库'
  });
  assert.equal(view.host?.id, 'ada');
  assert.equal(view.host?.removable, false);
  assert.deepEqual(view.speaking.map((member) => member.id), ['ada']);
  assert.equal(view.current.some((member) => member.id === 'orion'), false);
  assert.equal(view.current.some((member) => member.name === 'Gee'), true);
  assert.deepEqual(view.addBots.map((member) => member.id), ['orion']);
  assert.equal(view.addGroups.some((group) => group.id === 'data'), false);
  assert.equal(speakingBotIds([{ status: 'running', members: [{ botId: 'orion', status: 'running' }] }])[0], 'orion');

  assert.match(chat, /data-testid="room-working-members"/);
  assert.doesNotMatch(chat, /data-testid="play-group-members-open"/);
  assert.match(chat, /data-testid="play-group-speaking"/);
  assert.match(chat, /memberEditor=\{false\}/);
  const settingsAt = chat.indexOf('data-testid="room-settings"');
  const drawerAt = chat.indexOf('<RoomMemberDrawer');
  assert.ok(settingsAt > 0 && drawerAt > settingsAt);
  assert.doesNotMatch(chat, /className="play-group-member"/);
  assert.match(chat, /memberIds.filter\(id => workStates\[id\] > 0\)/);
  assert.match(drawer, /className="play-group-member"/);
  assert.match(drawer, /data-testid="play-group-member-search"/);
  assert.match(drawer, /data-testid="play-group-host"/);
  assert.match(drawer, /play-group-add-group-/);
  assert.doesNotMatch(drawer, /play-group-remove-group-/);
});

test('输入 @ 只显示群成员，并按职责或头衔找到名字不同的 Bot [AC:bot-room-console#AC-2]', () => {
  const inRoom = new Set(bots.map((bot) => bot.id));
  const open = mentionChoices(bots, [], '', inRoom);
  assert.equal(open.every((item) => item.kind === 'bot'), true);
  assert.equal(open.some((item) => item.name === '架构组'), false);
  assert.match(chat, /mentionChoices\(mentionRoster, \[\], mention.query/);
  const byDuty = mentionChoices(bots, [], '数据库', inRoom);
  const found = byDuty.find((item) => item.id === 'orion');
  assert.equal(found?.kind, 'bot');
  assert.equal(found?.name, 'Orion');
  assert.equal(found?.name.includes('数据库'), false);
  const byTitle = mentionChoices(bots, [], 'dba', inRoom);
  assert.equal(byTitle.some((item) => item.id === 'orion'), true);
  assert.match(chat, /mentionChoices/);
  assert.match(chat, /option\.insert/);
});

test('没有目标数据时不显示目标条；有进行中的目标时给出名称、波次和操作 [AC:bot-room-console#AC-3]', () => {
  assert.equal(readRoomGoal({ title: '群' }), null);
  assert.equal(readRoomGoal({ goal: { title: '做监控', status: 'cancelled', id: 'g1' } }), null);
  const goal = readRoomGoal({ goal: { id: 'g1', title: '做监控', status: 'running', progress: '编译中', wave: '第 1 波' } });
  assert.equal(goal?.title, '做监控');
  assert.equal(goal?.wave, '第 1 波');
  assert.equal(goal?.progress, '编译中');
  assert.equal(goal?.canControl, true);
  assert.match(goalBar, /if \(!goal\) return null/);
  assert.match(goalBar, /play\.roomGoal\.pause/);
  assert.match(goalBar, /play\.roomGoal\.constraint/);
  assert.match(goalBar, /play\.roomGoal\.cancel/);
  assert.match(chat, /readRoomGoal\(room\)/);
  assert.doesNotMatch(goalBar, /做监控|第 1 波/);
});

test('成员列表、目标条和人数上限的中英文文案不同 [AC:bot-room-console#AC-4]', () => {
  const keys = [
    ['play.group.membersSearch', zh.play.group.membersSearch, en.play.group.membersSearch],
    ['play.group.hostLine', zh.play.group.hostLine, en.play.group.hostLine],
    ['play.group.speakingNow', zh.play.group.speakingNow, en.play.group.speakingNow],
    ['play.group.addGroup', zh.play.group.addGroup, en.play.group.addGroup],
    ['play.group.removeGroup', zh.play.group.removeGroup, en.play.group.removeGroup],
    ['play.roomGoal.title', zh.play.roomGoal.title, en.play.roomGoal.title],
    ['play.roomGoal.pause', zh.play.roomGoal.pause, en.play.roomGoal.pause],
    ['play.roomGoal.constraint', zh.play.roomGoal.constraint, en.play.roomGoal.constraint],
    ['play.roomGoal.cancel', zh.play.roomGoal.cancel, en.play.roomGoal.cancel],
    ['settings.roomCapacity.rosterCap', zh.settings.roomCapacity.rosterCap, en.settings.roomCapacity.rosterCap],
    ['settings.roomCapacity.maxRoomMembers', zh.settings.roomCapacity.maxRoomMembers, en.settings.roomCapacity.maxRoomMembers],
    ['settings.roomCapacity.maxWaveSpeakers', zh.settings.roomCapacity.maxWaveSpeakers, en.settings.roomCapacity.maxWaveSpeakers]
  ] as const;
  for (const [key, chinese, english] of keys) {
    assert.ok(chinese.length > 0, key);
    assert.ok(english.length > 0, key);
    assert.notEqual(chinese, english, key);
  }
  assert.match(drawer, /useI18n/);
  assert.match(goalBar, /useI18n/);
  assert.match(capacity, /useI18n/);
});

test('人数上限仍在原设置里保存，群聊不新占一级导航 [AC:bot-room-console#AC-5]', () => {
  assert.match(capacity, /data-testid="room-capacity-roster"/);
  assert.match(capacity, /data-testid="room-capacity-members"/);
  assert.match(capacity, /data-testid="room-capacity-wave"/);
  assert.match(capacity, /data-testid="room-capacity-save"/);
  assert.match(capacity, /\/api\/bot-rooms\/settings/);
  assert.match(capacity, /method: 'PATCH'/);
  assert.match(general, /RoomCapacitySettingsCard/);
  assert.deepEqual(Object.keys(zh.shell.nav), ['label', 'primary', 'subPages', 'pending', 'collapse', 'expand', 'bot', 'chat', 'agents', 'tasks', 'knowledge', 'ops', 'settings', 'footMenu']);
  assert.deepEqual(Object.keys(en.shell.nav), Object.keys(zh.shell.nav));
  assert.equal(normalizeFunctionalGroups({ groups: [{ id: 'arch', name: '架构组', botIds: ['ada', 1] }, { name: '坏' }] }).length, 1);
});

test('已在群里只出现当前成员且群主无移出 [AC:group-member-sections#AC-1]', () => {
  const view = memberDrawer({
    memberIds: ['ada', 'orion', 'c', 'g'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: '架构'
  });
  assert.deepEqual(view.current.map((member) => member.id), ['ada', 'orion', 'c', 'g']);
  const host = view.current.find((member) => member.id === 'ada');
  assert.equal(host?.host, true);
  assert.equal(host?.removable, false);
  assert.equal(view.current.filter((member) => member.id !== 'ada').every((member) => member.removable), true);
  assert.equal(view.current.some((member) => member.id === 'd'), false);
  assert.equal(JSON.stringify(view).includes('未分组'), false);
  assert.match(drawer, /data-testid="play-group-current-members"/);
  assert.doesNotMatch(drawer, /play\.group\.ungrouped|未分组/);
  const currentBlock = drawer.slice(drawer.indexOf('play-group-current-members'), drawer.indexOf('play-group-add-members'));
  assert.doesNotMatch(currentBlock, /play-group-add-group-|play-group-member-search|play\.group\.addGroup/);
  assert.match(drawer, /member\.removable \?/);
  assert.equal(zh.play.group.currentMembers, '已在群里');
  assert.notEqual(zh.play.group.currentMembers, en.play.group.currentMembers);
});

test('添加区才有搜索和加入整组 [AC:group-member-sections#AC-2]', () => {
  const open = memberDrawer({
    memberIds: ['ada', 'orion'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: ''
  });
  assert.deepEqual(open.addGroups.map((group) => group.id), ['arch']);
  assert.equal('members' in (open.addGroups[0] ?? {}), false);
  assert.equal(open.addBots.some((bot) => bot.id === 'c'), false);
  assert.equal(open.addBots.some((bot) => bot.id === 'd'), true);
  assert.equal(open.addBots.some((bot) => bot.id === 'ada' || bot.id === 'orion'), false);
  assert.deepEqual(open.current.map((member) => member.id), ['ada', 'orion']);

  const byDuty = memberDrawer({
    memberIds: ['ada', 'c', 'd', 'e', 'f', 'g'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: '数据库'
  });
  assert.deepEqual(byDuty.addBots.map((bot) => bot.id), ['orion']);
  assert.equal(byDuty.current.some((member) => member.id === 'g'), true);
  assert.equal(byDuty.addGroups.length, 0);

  const byTitle = memberDrawer({
    memberIds: ['ada'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: 'dba'
  });
  assert.deepEqual(byTitle.addBots.map((bot) => bot.id), ['orion']);

  const byGroup = memberDrawer({
    memberIds: ['ada'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: '架构'
  });
  assert.deepEqual(byGroup.addGroups.map((group) => group.id), ['arch']);
  assert.equal(byGroup.addBots.some((bot) => bot.id === 'c'), false);
  assert.deepEqual(byGroup.current.map((member) => member.id), ['ada']);

  const full = memberDrawer({
    memberIds: ['ada', 'c', 'orion'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: '架构'
  });
  assert.deepEqual(full.addGroups, []);

  const currentAt = drawer.indexOf('data-testid="play-group-current-members"');
  const addAt = drawer.indexOf('data-testid="play-group-add-members"');
  const searchAt = drawer.indexOf('data-testid="play-group-member-search"');
  const groupAt = drawer.indexOf('play-group-add-group-');
  assert.ok(currentAt >= 0 && addAt > currentAt && searchAt > addAt && groupAt > searchAt);
  assert.equal(zh.play.group.addMembers, '添加成员');
  assert.equal(zh.play.group.addGroupRow, '{name} · 加入整组');
  assert.notEqual(zh.play.group.addMembers, en.play.group.addMembers);
  assert.notEqual(zh.play.group.addGroupRow, en.play.group.addGroupRow);
  assert.match(drawer, /play\.group\.addGroupRow/);
  assert.match(drawer, /play\.group\.membersSearch/);
});

test('同一职能组不会同时出现加入整组和移出整组 [AC:group-member-sections#AC-3]', () => {
  const view = memberDrawer({
    memberIds: ['ada', 'orion', 'e'],
    bots,
    groups,
    hostId: 'ada',
    speakingIds: [],
    query: ''
  });
  assert.equal(view.addGroups.some((group) => group.id === 'arch'), true);
  assert.equal(view.addGroups.some((group) => group.id === 'data'), false);
  for (const group of view.addGroups) {
    assert.equal('canRemove' in group, false);
    assert.equal('canAdd' in group, false);
    assert.equal('members' in group, false);
  }
  assert.doesNotMatch(drawer, /play-group-remove-group-|onRemoveGroup|play\.group\.removeGroup/);
  assert.match(drawer, /play-group-add-group-/);
  assert.match(drawer, /onAddGroup/);
  assert.equal(chat.includes('removeFunctionalGroup') || chat.includes('onRemoveGroup'), false);
});

test('审批策略不是群内处理时，群里不出现批准按钮 [AC:bot-room-console#AC-6]', () => {
  assert.equal(roomApprovalMode({ rosterCap: 50 }), 'private');
  assert.equal(roomApprovalMode({ approvalMode: 'room' }), 'room');
  assert.equal(showInlineApprove('private', true), false);
  assert.equal(showInlineApprove('room', false), false);
  assert.equal(showInlineApprove('room', memberNeedsPerson([{ status: 'waiting_approval' }])), true);
  const gate = chat.indexOf('showInlineApprove(');
  const button = chat.indexOf('data-testid="play-group-approve"');
  assert.ok(gate > 0 && button > gate);
  assert.match(chat, /approveVisible \?/);
  assert.doesNotMatch(chat, />\s*批准\s*</);
});
