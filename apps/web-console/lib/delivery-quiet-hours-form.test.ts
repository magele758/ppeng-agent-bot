import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from './i18n/t.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  commitQuietHoursWindow,
  draftFromQuietHours,
  QUIET_HOURS_PATH,
  quietHoursErrorText,
  type QuietHoursSettings
} from './delivery-quiet-hours-form.ts';

const saved: QuietHoursSettings = {
  enabled: false,
  startHour: 22,
  endHour: 8,
  timezone: 'Asia/Shanghai',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const hourText = translate(zh, 'settingsEntries.common.invalidRange', { min: 0, max: 23 });
const zoneText = translate(zh, 'settingsEntries.deliveryQuietHours.fields.timezone.invalid');

test('合法窗口只提交改过的字段 [AC:delivery-quiet-hours#AC-7]', async () => {
  const patches: unknown[] = [];
  const result = await commitQuietHoursWindow(
    saved,
    { startHour: '23', endHour: ' 8 ', timezone: ' Asia/Shanghai ' },
    { save: async (patch) => { patches.push(patch); return true; } },
    () => assert.fail('valid window must not report field errors')
  );
  assert.equal(result, true);
  assert.deepEqual(patches, [{ startHour: 23 }]);
  assert.equal(QUIET_HOURS_PATH, '/api/delivery/quiet-hours');
  assert.equal('enabled' in (patches[0] as object), false);
  assert.equal('updatedAt' in (patches[0] as object), false);
});

test('未改动的窗口不会发起保存 [AC:delivery-quiet-hours#AC-7]', async () => {
  let savedCalls = 0;
  let cleared = false;
  const result = await commitQuietHoursWindow(
    saved,
    draftFromQuietHours(saved),
    { save: async () => { savedCalls += 1; return true; } },
    () => assert.fail('unchanged window must not report field errors'),
    () => { cleared = true; }
  );
  assert.equal(result, true);
  assert.equal(savedCalls, 0);
  assert.equal(cleared, true);
});

test('非法小时或空白时区不会覆盖已保存窗口 [AC:delivery-quiet-hours#AC-8]', async () => {
  const patches: unknown[] = [];
  const reported: string[] = [];
  const result = await commitQuietHoursWindow(
    saved,
    { startHour: '24', endHour: '8', timezone: '   ' },
    { save: async (patch) => { patches.push(patch); return true; } },
    (errors) => {
      const text = quietHoursErrorText(errors, { hour: hourText, timezone: zoneText });
      reported.push(text.startHour ?? '', text.timezone ?? '');
    }
  );
  assert.equal(result, undefined);
  assert.deepEqual(patches, []);
  assert.deepEqual(reported, [hourText, zoneText]);
  assert.match(hourText, /0/);
  assert.match(hourText, /23/);
  assert.equal(zoneText, '请填写时区');
});
