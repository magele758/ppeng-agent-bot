import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { explicitGroupReplyMode, readGroupReplyMode, saveGroupReplyMode } from './group-reply-mode.ts';
import {
  debateConfigFromDraft,
  debateDraftFromRoom,
  debateDraftIssue,
  debateDraftReplies,
  debateLiveSpeakerId,
  debateProgress,
  debateSaveInit,
  effectiveDebateJudge,
  moveDebateRow,
  patchDebateRow,
  readDebateConfig,
  setDebateJudge
} from './group-debate.ts';

const control = readFileSync(new URL('../components/play-group/GroupReplyModeControl.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../components/play-group/GroupDebateSettings.tsx', import.meta.url), 'utf8');
const rooms = readFileSync(new URL('../components/bot-work/BotRooms.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../components/play-group/PlayBotGroupChat.tsx', import.meta.url), 'utf8');

const members = ['host', 'a', 'b'];

test('辩论是可选的回复方式，选中后出现轮数、参与者、立场和裁判的填写项 [AC:room-debate-mode#AC-13]', async () => {
  assert.equal(readGroupReplyMode({ room: { replyMode: 'debate' } }), 'debate');
  assert.equal(explicitGroupReplyMode({ replyMode: 'debate' }), 'debate');
  const saved = await saveGroupReplyMode(async (_path, init) => ({ room: JSON.parse(String(init?.body)) }), 'room_a', 'coordinator', 'debate');
  assert.deepEqual(saved, { mode: 'debate', error: '', saved: true });

  assert.match(control, /mode: 'debate', labelKey: 'play\.groupSettings\.debate'/);
  assert.match(control, /mode === 'debate' \? debateSettings : null/);
  assert.match(rooms, /debateSettings=\{<GroupDebateSettings room=\{room\}/);
  for (const id of ['group-debate-rounds', 'group-debate-judge', 'group-debate-row-', 'group-debate-save']) assert.ok(settings.includes(id), id);
  assert.match(settings, /play\.groupSettings\.debateStanceOf/);
  assert.doesNotMatch(settings, /[\u4e00-\u9fff]/);
  assert.match(chat, /<DebateProgress turns=\{turns\} \/>/);
  assert.match(chat, /const liveId = currentSpeakerId\(turns\)/);
  assert.match(chat, /const speakingIds = roomSpeakingIds\(turns\)/);

  const keys = ['debate', 'debateHint', 'debateFlow', 'debateUse', 'debateSettings', 'debateSettingsHint', 'debateRounds', 'debateJudge', 'debateJudgeDefault', 'debateJudgeNone', 'debateParticipants', 'debateStanceOf', 'debateStancePro', 'debateStanceCon', 'debateSave'] as const;
  for (const key of keys) {
    assert.ok(zh.play.groupSettings[key], `zh ${key}`);
    assert.ok(en.play.groupSettings[key], `en ${key}`);
    assert.notEqual(zh.play.groupSettings[key], en.play.groupSettings[key], key);
  }
  assert.equal(zh.play.groupSettings.debate, '辩论');
  assert.equal(en.play.groupSettings.debate, 'Debate');
  assert.match(zh.play.group.debateRound, /\{round\}.*\{rounds\}/);
  assert.match(en.play.group.debateRound, /\{round\}.*\{rounds\}/);
});

test('没有保存过辩论配置时，表单显示的默认值与实际开辩一致 [AC:room-debate-mode#AC-13] [AC:room-debate-mode#AC-2]', () => {
  assert.deepEqual(readDebateConfig({ id: 'r' }), {});
  assert.deepEqual(readDebateConfig({ debate: 'x' }), {});
  const draft = debateDraftFromRoom({}, members, 'host');
  assert.equal(draft.rounds, 3);
  assert.equal(draft.judge, 'default');
  assert.deepEqual(draft.rows, [{ botId: 'host', joined: false, stance: '' }, { botId: 'a', joined: true, stance: '' }, { botId: 'b', joined: true, stance: '' }]);
  assert.equal(effectiveDebateJudge(draft, 'host'), 'host');
  assert.equal(debateDraftReplies(draft, 'host'), 7);
  assert.equal(debateDraftIssue(draft), null);

  const pair = debateDraftFromRoom({}, ['host', 'a'], 'host');
  assert.deepEqual(pair.rows.map(row => row.joined), [true, true]);
  assert.equal(effectiveDebateJudge(pair, 'host'), '');
  assert.equal(debateDraftReplies(pair, 'host'), 6);
});

test('保存过的轮数、顺序、立场和裁判原样回到表单，并原样提交 [AC:room-debate-mode#AC-13] [AC:room-debate-mode#AC-1]', () => {
  const config = readDebateConfig({ debate: { rounds: 4, participants: [{ botId: 'b', stance: '支持' }, { botId: 'a' }, { botId: 'gone' }, 7], judgeBotId: 'host' } });
  assert.deepEqual(config, { rounds: 4, participants: [{ botId: 'b', stance: '支持' }, { botId: 'a' }, { botId: 'gone' }], judgeBotId: 'host' });
  const draft = debateDraftFromRoom(config, members, 'host');
  assert.deepEqual(draft, { rounds: 4, judge: 'host', rows: [{ botId: 'b', joined: true, stance: '支持' }, { botId: 'a', joined: true, stance: '' }, { botId: 'host', joined: false, stance: '' }] });
  assert.deepEqual(debateConfigFromDraft(draft), { rounds: 4, participants: [{ botId: 'b', stance: '支持' }, { botId: 'a' }], judgeBotId: 'host' });
  assert.deepEqual(JSON.parse(String(debateSaveInit(draft).body)), { debate: debateConfigFromDraft(draft) });
  assert.equal(debateSaveInit(draft).method, 'PATCH');

  assert.equal(debateDraftFromRoom({ judgeBotId: null }, members, 'host').judge, 'none');
  assert.deepEqual(debateDraftFromRoom({ judgeBotId: null }, members, 'host').rows.map(row => row.joined), [true, true, true]);
  assert.equal(debateConfigFromDraft(debateDraftFromRoom({ judgeBotId: null }, members, 'host')).judgeBotId, null);
  assert.equal('judgeBotId' in debateConfigFromDraft(debateDraftFromRoom({}, members, 'host')), false);
  assert.equal(debateDraftFromRoom({ judgeBotId: 'gone', rounds: 99 }, members, 'host').judge, 'default');
  assert.equal(debateDraftFromRoom({ rounds: 99 }, members, 'host').rounds, 10);
});

test('调整顺序、勾选参与者和改裁判后，表单给出可保存的结果或说明原因 [AC:room-debate-mode#AC-13]', () => {
  let draft = debateDraftFromRoom({}, members, 'host');
  draft = moveDebateRow(draft, 'b', -1);
  assert.deepEqual(draft.rows.map(row => row.botId), ['host', 'b', 'a']);
  assert.equal(moveDebateRow(draft, 'host', -1), draft);
  assert.equal(moveDebateRow(draft, 'a', 1), draft);
  assert.equal(moveDebateRow(draft, 'nobody', 1), draft);
  draft = patchDebateRow(draft, 'b', { stance: '  猫更好  ' });
  assert.deepEqual(debateConfigFromDraft(draft).participants, [{ botId: 'b', stance: '猫更好' }, { botId: 'a' }]);

  // Choosing a debater as judge takes it off the sides; putting the judge on a side releases the seat.
  draft = setDebateJudge(draft, 'a');
  assert.equal(draft.rows.find(row => row.botId === 'a')?.joined, false);
  assert.equal(debateDraftIssue(draft), 'need_two');
  draft = patchDebateRow(draft, 'a', { joined: true });
  assert.equal(draft.judge, 'default');
  draft = patchDebateRow(draft, 'host', { joined: true });
  assert.equal(effectiveDebateJudge(draft, 'host'), '');
  assert.equal(debateDraftReplies(draft, 'host'), 9);
  draft = setDebateJudge(draft, 'none');
  assert.equal(effectiveDebateJudge(draft, 'host'), '');

  assert.equal(debateDraftIssue({ ...draft, rounds: 0 }), 'rounds');
  assert.equal(debateDraftIssue({ ...draft, rounds: 2.5 }), 'rounds');
  const nine = { rounds: 1, judge: 'none', rows: Array.from({ length: 9 }, (_, index) => ({ botId: `m${index}`, joined: true, stance: '' })) };
  assert.equal(debateDraftIssue(nine), 'too_many');
  assert.equal(debateDraftIssue({ ...nine, rounds: 10, rows: nine.rows.slice(0, 5) }), 'too_long');
  assert.equal(debateDraftIssue({ ...nine, rounds: 8, rows: nine.rows.slice(0, 5) }), null);
});

test('辩论进行时，界面知道现在轮到谁、第几轮，裁决时显示裁判 [AC:room-debate-mode#AC-13] [AC:room-debate-mode#AC-3]', () => {
  const debate = { rounds: 2, participants: [{ botId: 'a', stance: '正方' }, { botId: 'b', stance: '反方' }], judgeBotId: 'host', speeches: 4, step: 0 };
  const at = (step: number, extra = {}) => [{ status: 'completed' }, { status: 'running', debate: { ...debate, step, ...extra } }];
  assert.equal(debateLiveSpeakerId(at(0)), 'a');
  assert.equal(debateLiveSpeakerId(at(1)), 'b');
  assert.equal(debateLiveSpeakerId(at(2)), 'a');
  assert.deepEqual(debateProgress(at(1)), { verdict: false, round: 1, rounds: 2 });
  assert.deepEqual(debateProgress(at(3)), { verdict: false, round: 2, rounds: 2 });
  assert.equal(debateLiveSpeakerId(at(4)), 'host');
  assert.deepEqual(debateProgress(at(4)), { verdict: true, round: 2, rounds: 2 });
  assert.equal(debateLiveSpeakerId(at(4, { verdictDone: true })), '');
  assert.equal(debateLiveSpeakerId(at(4, { judgeBotId: undefined })), '');
  assert.equal(debateLiveSpeakerId([{ status: 'running' }]), '');
  assert.equal(debateProgress([{ status: 'queued', debate }]), null);
});
