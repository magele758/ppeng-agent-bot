import test from 'node:test';
import assert from 'node:assert/strict';
import { cronFromTime, describeCron, parseCronUserPrompt, parseTimeValue, routinePrecheckPayload } from './cron.ts';
import { play as zhPlay } from './i18n/messages/zh/play.ts';
import { play as enPlay } from './i18n/messages/en/play.ts';

test('cronFromTime presets', () => {
  assert.equal(cronFromTime({ hour: 9, minute: 30, preset: 'daily' }), '30 9 * * *');
  assert.equal(cronFromTime({ hour: 18, minute: 0, preset: 'weekdays' }), '0 18 * * 1-5');
  assert.equal(cronFromTime({ hour: 9, minute: 0, preset: 'weekly', weekday: 1 }), '0 9 * * 1');
  assert.equal(cronFromTime({ hour: 0, minute: 15, preset: 'hourly' }), '15 * * * *');
});

test('describeCron covers common presets', () => {
  assert.equal(describeCron('30 9 * * *'), '每天 09:30');
  assert.equal(describeCron('0 18 * * 1-5'), '工作日 18:00');
  assert.equal(describeCron('15 * * * *'), '每小时的 15 分');
});

test('parseCronUserPrompt', () => {
  const parsed = parseCronUserPrompt('[cron:晨报] 总结昨日进展');
  assert.deepEqual(parsed, { name: '晨报', body: '总结昨日进展' });
  assert.equal(parseCronUserPrompt('普通消息'), null);
});

test('静默确认有中英文且不是静默标记本身 [AC:bot-gateway-delivery#AC-2]', () => {
  assert.equal(zhPlay.imSilentAck, '收到，没有更多要补充的。');
  assert.equal(enPlay.imSilentAck, 'Got it. Nothing more to add.');
  assert.notEqual(zhPlay.imSilentAck, enPlay.imSilentAck);
  assert.doesNotMatch(zhPlay.imSilentAck, /SILENT|NO_REPLY/);
  assert.doesNotMatch(enPlay.imSilentAck, /SILENT|NO_REPLY/);
});

test('routinePrecheckPayload omits an empty precheck', () => {
  assert.equal(routinePrecheckPayload('none', 'printf hi'), undefined);
  assert.equal(routinePrecheckPayload('script', '  '), undefined);
  assert.deepEqual(routinePrecheckPayload('predicate', ' {"wakeAgent":false} '), {
    kind: 'predicate',
    source: '{"wakeAgent":false}'
  });
});

test('parseTimeValue', () => {
  assert.deepEqual(parseTimeValue('09:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseTimeValue('bad'), { hour: 9, minute: 0 });
});
