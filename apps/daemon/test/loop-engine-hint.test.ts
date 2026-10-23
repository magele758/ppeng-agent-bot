import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLoopSettings, loopSettingsAsRuntimeHint } from '../src/loop-settings.ts';

test('disabled engine reports effective defaults without erasing saved settings [AC:experimental-settings#AC-5]', () => {
  const settings = { ...defaultLoopSettings(), engineEnabled: false, inboxOverflowCap: 3 };
  assert.equal(loopSettingsAsRuntimeHint(settings).inboxOverflowCap, null);
  assert.equal(settings.inboxOverflowCap, 3);
});
