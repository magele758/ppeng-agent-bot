/**
 * Daemon-owned loop settings + steer HTTP mapping (Phase 4 host).
 * Lives in core/test so it runs with `pnpm run test:unit` after daemon tsc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { AGENT_LOOP_SETTINGS_KEY, resolveSteerDrainPolicy } from '../dist/session/steer-drain.js';
import {
  parseInboxOverflowCap,
  resolveInboxOverflowCap,
  SUGGESTED_INBOX_OVERFLOW_CAP
} from '../dist/session/inbox-overflow.js';
import {
  defaultLoopSettings,
  hasPersistedLoopSettings,
  LOOP_SETTINGS_KEY,
  loopSettingsAsRuntimeHint,
  parseSteerDrainPolicy,
  readLoopSettings,
  writeLoopSettings
} from '../../../apps/daemon/src/loop-settings.ts';
import { steerHttpFromCoreAck } from '../../../apps/daemon/dist/steer-ack.js';

test('loop settings default is next_shot_only and persist in daemon_control KV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-settings-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));

  assert.equal(LOOP_SETTINGS_KEY, AGENT_LOOP_SETTINGS_KEY);
  assert.equal(hasPersistedLoopSettings(store), false);
  assert.equal(readLoopSettings(store).steerDrainPolicy, 'next_shot_only');
  assert.equal(readLoopSettings(store).inboxOverflowCap, null);
  assert.equal(readLoopSettings(store).defaultTaskMode, 'auto');
  assert.equal(readLoopSettings(store).defaultSkillScope, 'full');
  assert.equal(readLoopSettings(store).steerInterruptPolicy, 'queue');
  assert.equal(readLoopSettings(store).kernelVariant, 'agent-loop');
  assert.equal(readLoopSettings(store).assemblyPreset, 'max');
  assert.equal(defaultLoopSettings().kernelVariant, 'agent-loop');
  assert.equal(defaultLoopSettings().assemblyPreset, 'max');
  assert.equal(defaultLoopSettings().steerDrainPolicy, 'next_shot_only');
  assert.equal(defaultLoopSettings().inboxOverflowCap, null);
  assert.equal(defaultLoopSettings().defaultTaskMode, 'auto');
  assert.equal(defaultLoopSettings().defaultSkillScope, 'full');
  assert.equal(defaultLoopSettings().steerInterruptPolicy, 'queue');
  assert.equal(parseSteerDrainPolicy('nope'), undefined);
  assert.equal(parseSteerDrainPolicy('tool_launch'), 'tool_launch');
  assert.equal(resolveSteerDrainPolicy({ store }), 'next_shot_only');
  assert.equal(resolveInboxOverflowCap({ store }), null);

  const saved = writeLoopSettings(store, { steerDrainPolicy: 'tool_launch' });
  assert.equal(hasPersistedLoopSettings(store), true);
  assert.equal(saved.steerDrainPolicy, 'tool_launch');
  assert.equal(saved.inboxOverflowCap, null);
  assert.equal(readLoopSettings(store).steerDrainPolicy, 'tool_launch');
  assert.deepEqual(loopSettingsAsRuntimeHint(saved), {
    steerDrainPolicy: 'tool_launch',
    inboxOverflowCap: null,
    defaultTaskMode: 'auto',
    defaultSkillScope: 'full',
    steerInterruptPolicy: 'queue'
  });
  assert.equal(store.getDaemonControl(AGENT_LOOP_SETTINGS_KEY).steerDrainPolicy, 'tool_launch');
  assert.equal(resolveSteerDrainPolicy({ store }), 'tool_launch');

  writeLoopSettings(store, { defaultTaskMode: 'fast', defaultSkillScope: 'requested' });
  assert.equal(readLoopSettings(store).defaultTaskMode, 'fast');
  assert.equal(readLoopSettings(store).defaultSkillScope, 'requested');
  writeLoopSettings(store, { steerDrainPolicy: 'next_shot_only' });
  assert.equal(readLoopSettings(store).steerDrainPolicy, 'next_shot_only');
  assert.equal(readLoopSettings(store).defaultTaskMode, 'fast');
  assert.equal(resolveSteerDrainPolicy({ store }), 'next_shot_only');
  assert.equal(readLoopSettings(store).inboxOverflowCap, null);

  writeLoopSettings(store, { steerInterruptPolicy: 'disabled' });
  assert.equal(readLoopSettings(store).steerInterruptPolicy, 'disabled');
  writeLoopSettings(store, { steerDrainPolicy: 'tool_launch' });
  assert.equal(readLoopSettings(store).steerInterruptPolicy, 'disabled', 'patching drain must keep interrupt');

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('steer HTTP ack maps core SteerAck onto {ok, queued|steered|rejected}', () => {
  const item = { id: 'item' };
  const steered = steerHttpFromCoreAck(
    { status: 'steered', item },
    { id: 's1', status: 'running' }
  );
  assert.equal(steered.ok, true);
  assert.equal(steered.status, 'steered');
  assert.equal(steered.item.id, 'item');

  const started = steerHttpFromCoreAck(
    { status: 'started', item },
    { id: 's1', status: 'idle' }
  );
  assert.equal(started.ok, true);
  assert.equal(started.status, 'queued');
  assert.equal(started.item.id, 'item');

  const missing = steerHttpFromCoreAck({ status: 'not_submitted', reason: 'no_session' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.reason, 'no_session');

  const ended = steerHttpFromCoreAck(
    { status: 'not_submitted', reason: 'session_ended' },
    { id: 's1', status: 'completed' }
  );
  assert.equal(ended.ok, false);
  assert.equal(ended.status, 'rejected');
  assert.equal(ended.session.id, 's1');
});

test('loop settings persist inboxOverflowCap; default unlimited until Lab opens it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-overflow-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));

  assert.equal(parseInboxOverflowCap(null), null);
  assert.equal(parseInboxOverflowCap(2), 2);
  assert.equal(resolveInboxOverflowCap({ store }), null);

  const opened = writeLoopSettings(store, { inboxOverflowCap: 2 });
  assert.equal(opened.inboxOverflowCap, 2);
  assert.equal(readLoopSettings(store).inboxOverflowCap, 2);
  assert.equal(store.getDaemonControl(AGENT_LOOP_SETTINGS_KEY).inboxOverflowCap, 2);
  assert.equal(resolveInboxOverflowCap({ store }), 2);
  assert.deepEqual(loopSettingsAsRuntimeHint(opened), {
    steerDrainPolicy: 'next_shot_only',
    inboxOverflowCap: 2,
    defaultTaskMode: 'auto',
    defaultSkillScope: 'full',
    steerInterruptPolicy: 'queue'
  });

  writeLoopSettings(store, { steerDrainPolicy: 'tool_launch' });
  assert.equal(readLoopSettings(store).inboxOverflowCap, 2, 'patching drain must keep cap');

  const suggested = writeLoopSettings(store, { inboxOverflowCap: SUGGESTED_INBOX_OVERFLOW_CAP });
  assert.equal(suggested.inboxOverflowCap, 20);

  const closed = writeLoopSettings(store, { inboxOverflowCap: null });
  assert.equal(closed.inboxOverflowCap, null);
  assert.equal(resolveInboxOverflowCap({ store }), null);

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
