import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOM_SPEAKER_CLEAR_LEAD,
  ROOM_SPEAKER_SCORE_THRESHOLD,
  isShortRoomNegation,
  isWithheldRoomReply,
  scoreRoomSpeaker,
  selectFollowUpSpeaker,
  selectUnnamedSpeakers
} from '../dist/rooms/speaker-score.js';

const host = { id: 'host', name: '群主甲', title: '群主甲', description: '', groupName: '' };
const cert = { id: 'cert', name: '甲', title: '证书管理员', description: '负责集群证书续期', groupName: '' };
const idle = { id: 'idle', name: '闲聊乙', title: '闲聊乙', description: '', groupName: '' };

test('title, description, and group each clear the line on their own [AC:bot-room-speaker-pick#AC-1]', () => {
  assert.ok(ROOM_SPEAKER_SCORE_THRESHOLD >= 2);
  const message = '证书怎么续期';
  assert.ok(scoreRoomSpeaker(message, cert) >= ROOM_SPEAKER_SCORE_THRESHOLD);
  assert.equal(scoreRoomSpeaker(message, host), 0);
  assert.equal(scoreRoomSpeaker(message, idle), 0);
  const byGroup = selectUnnamedSpeakers(message, [
    host,
    { id: 'desk', name: '丙', title: '丙', description: '', groupName: '证书组' },
    idle
  ], 4);
  assert.deepEqual(byGroup.botIds, ['desk']);
  const byDescription = selectUnnamedSpeakers('kubernetes 证书怎么续期', [
    host,
    { id: 'ops', name: '丁', title: '丁', description: '负责 kubernetes 证书续期', groupName: '' }
  ], 4);
  assert.deepEqual(byDescription.botIds, ['ops']);
});

test('only the highest matches within the cap are woken, host included only when they match [AC:bot-room-speaker-pick#AC-2]', () => {
  const cards = [
    { id: 'a', name: '甲', title: '证书管理员', description: '', groupName: '' },
    { id: 'b', name: '乙', title: '乙', description: '证书续期手册', groupName: '' },
    { id: 'c', name: '丙', title: '证书值班', description: '', groupName: '' },
    host
  ];
  const plan = selectUnnamedSpeakers('证书续期', cards, 2);
  assert.equal(plan.botIds.length, 2);
  assert.ok(plan.botIds.includes('b'));
  assert.ok(!plan.botIds.includes('c'));
  assert.ok(!plan.botIds.includes(host.id));
  const withHost = selectUnnamedSpeakers('证书续期', [
    { ...host, title: '证书值班' },
    { id: 'b', name: '乙', title: '乙', description: '证书续期手册', groupName: '' }
  ], 4);
  assert.ok(withHost.botIds.includes(host.id));
  assert.ok(withHost.botIds.includes('b'));
});

test('follow-up adds only the one unspoken member who clearly beats the host [AC:bot-room-speaker-pick#AC-4]', () => {
  assert.ok(ROOM_SPEAKER_CLEAR_LEAD >= 2);
  const scores = [
    { id: 'expert', score: 6 },
    { id: 'next', score: 3 },
    { id: 'later', score: 3 },
    { id: 'host', score: 0 },
    { id: 'idle', score: 0 }
  ];
  assert.equal(selectFollowUpSpeaker({
    scores,
    hostBotId: 'host',
    alreadyScheduled: ['expert', 'host']
  }), 'next');
  assert.equal(selectFollowUpSpeaker({
    scores,
    hostBotId: 'host',
    alreadyScheduled: ['expert', 'host', 'next']
  }), 'later');
  assert.equal(selectFollowUpSpeaker({
    scores: scores.map(item => item.id === 'host' ? { id: 'host', score: 3 } : item),
    hostBotId: 'host',
    alreadyScheduled: ['expert', 'host']
  }), undefined);
});

test('short refusals stay out of the room and a longer sentence does not [AC:bot-room-speaker-pick#AC-6]', () => {
  for (const text of ['我不知道', '我不知道。', '我不知道啊', '不清楚呢', '没有要补充', '没有要补充吧', '  我不清楚  ', '没有补充']) {
    assert.equal(isShortRoomNegation(text), true, text);
    assert.equal(isWithheldRoomReply(text), true, text);
  }
  assert.equal(isShortRoomNegation('我不知道，但是可以从吊销列表看'), false);
  assert.equal(isWithheldRoomReply('我不知道，但是可以从吊销列表看'), false);
  assert.equal(isShortRoomNegation('证书要在到期前轮换'), false);
  assert.equal(isWithheldRoomReply('证书要在到期前轮换啊'), false);
  for (const text of ['[SILENT]', '[SILENT].', '  silent  ', 'NO_REPLY。']) {
    assert.equal(isWithheldRoomReply(text), true, text);
  }
  assert.equal(isWithheldRoomReply('SILENT deploy needed'), false);
  assert.equal(isWithheldRoomReply(''), true);
});
