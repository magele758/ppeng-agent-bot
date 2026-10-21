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
    memberIds: bots.map((bot) => bot.id),
    bots,
    groups,
    hostId: 'ada',
    speakingIds: ['orion'],
    query: '数据库',
    ungroupedLabel: '未分组'
  });
  assert.equal(view.host?.id, 'ada');
  assert.deepEqual(view.speaking.map((member) => member.id), ['orion']);
  const data = view.sections.find((section) => section.id === 'data');
  assert.equal(data?.members.some((member) => member.id === 'orion'), true);
  assert.equal(view.sections.some((section) => section.members.some((member) => member.name === 'Gee')), false);
  assert.equal(speakingBotIds([{ status: 'running', members: [{ botId: 'orion', status: 'running' }] }])[0], 'orion');

  assert.match(chat, /tileMembersInHeader/);
  assert.match(chat, /data-testid="play-group-member-summary"/);
  assert.match(chat, /data-testid="play-group-members-open"/);
  assert.match(chat, /data-testid="play-group-speaking"/);
  assert.match(chat, /memberEditor=\{!crowded\}/);
  const summaryAt = chat.indexOf('data-testid="play-group-member-summary"');
  const tileAt = chat.indexOf('className="play-group-member"');
  assert.ok(summaryAt > 0 && tileAt > summaryAt);
  assert.doesNotMatch(chat.slice(summaryAt, tileAt), /play\.group\.remove|play-group-add/);
  assert.match(drawer, /data-testid="play-group-member-search"/);
  assert.match(drawer, /data-testid="play-group-host"/);
  assert.match(drawer, /play-group-add-group-/);
  assert.match(drawer, /play-group-remove-group-/);
});

test('输入 @ 能看到职能组，并按职责或头衔找到名字不同的 Bot [AC:bot-room-console#AC-2]', () => {
  const inRoom = new Set(bots.map((bot) => bot.id));
  const open = mentionChoices(bots, groups, '', inRoom);
  assert.equal(open[0]?.kind, 'group');
  assert.equal(open.some((item) => item.kind === 'group' && item.name === '架构组'), true);
  assert.equal(open.find((item) => item.id === 'arch')?.insert, 'Ada @Cee');
  const byDuty = mentionChoices(bots, groups, '数据库', inRoom);
  const found = byDuty.find((item) => item.id === 'orion');
  assert.equal(found?.kind, 'bot');
  assert.equal(found?.name, 'Orion');
  assert.equal(found?.name.includes('数据库'), false);
  const byTitle = mentionChoices(bots, groups, 'dba', inRoom);
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
  assert.deepEqual(Object.keys(zh.shell.nav), ['label', 'primary', 'subPages', 'pending', 'collapse', 'expand', 'bot', 'chat', 'agents', 'tasks', 'knowledge', 'ops', 'settings']);
  assert.deepEqual(Object.keys(en.shell.nav), Object.keys(zh.shell.nav));
  assert.equal(normalizeFunctionalGroups({ groups: [{ id: 'arch', name: '架构组', botIds: ['ada', 1] }, { name: '坏' }] }).length, 1);
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
