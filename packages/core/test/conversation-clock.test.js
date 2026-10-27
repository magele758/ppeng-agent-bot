import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSOLUTE_DATE_SUMMARY_RULE,
  CLOCK_NOTICE_MARK,
  appendClockNotice,
  conversationClockNotice,
  formatWrittenAt,
  resolveConversationTimezone,
  stampWrittenAt,
  zonedClock
} from '../src/session/conversation-clock.ts';

const SHANGHAI_EVENING_UTC = Date.parse('2026-10-26T15:30:00.000Z');
const SHANGHAI_AFTER_UTC_MIDNIGHT = Date.parse('2026-10-26T16:30:00.000Z');

test('calendar day follows the session timezone, not UTC', () => {
  assert.equal(resolveConversationTimezone({ timezone: 'Asia/Shanghai' }), 'Asia/Shanghai');
  assert.equal(resolveConversationTimezone({ timezone: 'not-a-zone' }), resolveConversationTimezone({}));
  assert.equal(resolveConversationTimezone({ timezone: '' }), resolveConversationTimezone(null));

  const stillLocal = zonedClock(SHANGHAI_EVENING_UTC, 'Asia/Shanghai');
  assert.equal(stillLocal.date, '2026-10-26');
  assert.equal(stillLocal.time, '23:30');
  assert.notEqual(stillLocal.date, '2026-10-27');

  const utcAlreadyNext = zonedClock(SHANGHAI_EVENING_UTC, 'UTC');
  assert.equal(utcAlreadyNext.date, '2026-10-26');
  assert.equal(utcAlreadyNext.time, '15:30');

  const localNextDay = zonedClock(SHANGHAI_AFTER_UTC_MIDNIGHT, 'Asia/Shanghai');
  assert.equal(localNextDay.date, '2026-10-27');
  assert.equal(localNextDay.time, '00:30');
  assert.equal(zonedClock(SHANGHAI_AFTER_UTC_MIDNIGHT, 'UTC').date, '2026-10-26');
  assert.equal(localNextDay.weekday, 'Tuesday');
});

test('old messages keep the day they were written', () => {
  const old = {
    id: 'old',
    role: 'user',
    createdAt: '2026-10-20T01:14:00.000Z',
    parts: [{ type: 'text', text: '今天把方案定了，明天评审' }]
  };
  const now = {
    id: 'now',
    role: 'user',
    createdAt: '2026-10-27T02:00:00.000Z',
    parts: [{ type: 'text', text: '今天是几号' }]
  };
  const assistant = {
    id: 'a',
    role: 'assistant',
    createdAt: '2026-10-20T01:20:00.000Z',
    parts: [{ type: 'text', text: '明天我来写结论' }]
  };
  const tool = {
    id: 't',
    role: 'tool',
    createdAt: '2026-10-20T01:15:00.000Z',
    parts: [{ type: 'tool_result', toolCallId: 'c1', ok: true, content: '今天的文件' }]
  };
  const stamped = stampWrittenAt([old, assistant, tool, now], 'Asia/Shanghai');
  assert.match(stamped[0].parts[0].text, /^\[written 2026-10-20 09:14 Asia\/Shanghai\]\n今天把方案定了/);
  assert.match(stamped[1].parts[0].text, /^\[written 2026-10-20 09:20 Asia\/Shanghai\]\n明天我来写结论/);
  assert.equal(stamped[2], tool);
  assert.match(stamped[3].parts[0].text, /^\[written 2026-10-27 10:00 Asia\/Shanghai\]\n今天是几号/);
  assert.equal(formatWrittenAt('not-a-date', 'Asia/Shanghai'), undefined);
  assert.equal(formatWrittenAt(new Date(0).toISOString(), 'UTC'), undefined);
  const twice = stampWrittenAt(stamped, 'Asia/Shanghai');
  assert.equal(twice[0].parts[0].text, stamped[0].parts[0].text);
});

test('the live clock is a copy and is not written back onto the saved message', () => {
  const saved = {
    role: 'user',
    createdAt: '2026-10-20T01:14:00.000Z',
    parts: [{ type: 'text', text: '今天开会' }]
  };
  const stamped = stampWrittenAt([saved], 'Asia/Shanghai');
  const noticed = appendClockNotice(stamped, SHANGHAI_AFTER_UTC_MIDNIGHT, 'Asia/Shanghai');
  assert.equal(saved.parts.length, 1);
  assert.equal(saved.parts[0].text, '今天开会');
  assert.equal(stamped[0].parts.length, 1);
  assert.equal(noticed[0].parts.length, 2);
  assert.match(noticed[0].parts[1].text, /Current time: 2026-10-27 00:30 Tuesday \(Asia\/Shanghai\)/);
  assert.match(noticed[0].parts[1].text, /今天/);
  assert.ok(noticed[0].parts[1].text.startsWith(CLOCK_NOTICE_MARK));
  const again = appendClockNotice(noticed, SHANGHAI_AFTER_UTC_MIDNIGHT, 'UTC');
  assert.equal(again[0].parts.length, 2);
  assert.match(again[0].parts[1].text, /Asia\/Shanghai/);
  assert.equal(appendClockNotice([{ role: 'assistant', createdAt: saved.createdAt, parts: saved.parts }], 0, 'UTC').length, 1);
});

test('the tail notice carries the calendar date', () => {
  const line = conversationClockNotice(SHANGHAI_AFTER_UTC_MIDNIGHT, 'Asia/Shanghai');
  assert.match(line, /2026-10-27 00:30 Tuesday \(Asia\/Shanghai\)/);
  assert.ok(line.startsWith(CLOCK_NOTICE_MARK));
  assert.match(ABSOLUTE_DATE_SUMMARY_RULE, /YYYY-MM-DD/);
  assert.match(ABSOLUTE_DATE_SUMMARY_RULE, /今天/);
});
