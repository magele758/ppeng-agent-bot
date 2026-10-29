import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronFromTime, defaultRoutineSchedule } from './cron.ts';

test('新建例行任务表单默认是工作日上午，而不是每天或整夜 [AC:routine-weekday-daytime-default#AC-1]', () => {
  const schedule = defaultRoutineSchedule();
  assert.equal(schedule.preset, 'weekdays');
  assert.equal(schedule.time, '09:00');
  assert.equal(schedule.cron, '0 9 * * 1-5');
  assert.equal(cronFromTime({ hour: 9, minute: 0, preset: 'weekdays' }), schedule.cron);
  const panel = readFileSync(new URL('../components/BotCronPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /defaultRoutineSchedule\(\)/);
});

test('表单里另行选中的每天或每小时不会被工作日默认盖掉 [AC:routine-weekday-daytime-default#AC-2]', () => {
  assert.equal(cronFromTime({ hour: 3, minute: 0, preset: 'daily' }), '0 3 * * *');
  assert.equal(cronFromTime({ hour: 0, minute: 15, preset: 'hourly' }), '15 * * * *');
  assert.notEqual(defaultRoutineSchedule().cron, cronFromTime({ hour: 3, minute: 0, preset: 'daily' }));
});
