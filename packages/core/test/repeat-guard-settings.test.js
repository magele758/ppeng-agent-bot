/**
 * Saved loop_settings.repeatGuard is what the next tool round reads.
 * No RAW_AGENT_* switch and no process restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  parseRepeatGuardMode as parseDaemonRepeatGuard,
  readLoopSettings,
  writeLoopSettings,
  LOOP_SETTINGS_KEY,
} from '../../../apps/daemon/src/loop-settings.ts';
import {
  parseRepeatGuardMode as parseLoopRepeatGuard,
  resolveRepeatGuardMode,
} from '../../agent-loop/src/recovery/repeat-guard.ts';
import { SENSITIVE_READ_REFUSAL, sensitiveReadRefusal } from '../dist/workspace/sensitive-read.js';

test('repeat guard defaults to weak and the next read sees a save [AC:loop-guard-model-switch#AC-3] [AC:loop-guard-model-switch#AC-5]', () => {
  for (const value of ['weak', 'all', 'off', 'nope', undefined, 1]) {
    assert.equal(parseDaemonRepeatGuard(value), parseLoopRepeatGuard(value));
  }

  const dir = mkdtempSync(join(tmpdir(), 'repeat-guard-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    assert.equal(readLoopSettings(store).repeatGuard, 'weak');
    assert.equal(resolveRepeatGuardMode(store), 'weak');

    store.setDaemonControl(LOOP_SETTINGS_KEY, { steerDrainPolicy: 'tool_launch' });
    assert.equal(readLoopSettings(store).repeatGuard, 'weak');
    assert.equal(resolveRepeatGuardMode(store), 'weak');

    assert.equal(writeLoopSettings(store, { repeatGuard: 'all' }).repeatGuard, 'all');
    assert.equal(resolveRepeatGuardMode(store), 'all');
    assert.equal(readLoopSettings(store).steerDrainPolicy, 'tool_launch');

    writeLoopSettings(store, { defaultTaskMode: 'fast' });
    assert.equal(readLoopSettings(store).repeatGuard, 'all');
    assert.equal(resolveRepeatGuardMode(store), 'all');

    writeLoopSettings(store, { repeatGuard: 'off' });
    assert.equal(readLoopSettings(store).repeatGuard, 'off');
    assert.equal(resolveRepeatGuardMode(store), 'off');
    assert.equal(readLoopSettings(store).defaultTaskMode, 'fast');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sensitive paths stay refused [AC:loop-guard-model-switch#AC-4]', () => {
  assert.equal(sensitiveReadRefusal('/tmp/project/.env'), SENSITIVE_READ_REFUSAL);
  assert.equal(sensitiveReadRefusal('/tmp/project/src/app.ts'), undefined);
});
