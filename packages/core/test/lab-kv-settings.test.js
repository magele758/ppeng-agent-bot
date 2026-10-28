import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultGoalSettings,
  normalizeGoalSettings,
  readGoalSettings,
  writeGoalSettings
} from '../dist/goal/settings.js';
import {
  defaultIngestionSettings,
  normalizeIngestionSettings,
  writeIngestionSettings
} from '../dist/ingestion/settings.js';
import {
  defaultTeamsDagSettings,
  normalizeTeamsDagSettings,
  writeTeamsDagSettings
} from '../dist/teams/settings.js';
import { writeEventLogSettings } from '../dist/session/event-log-settings.js';

function kvStore() {
  const map = new Map();
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

test('goal settings clamp maxTurns and persist via KV', () => {
  assert.equal(defaultGoalSettings().entityEnabled, true);
  assert.equal(normalizeGoalSettings({ defaultMaxTurns: 999 }).defaultMaxTurns, 100);
  assert.equal(normalizeGoalSettings({ defaultMaxTurns: 0 }).defaultMaxTurns, 0);
  const store = kvStore();
  assert.equal(readGoalSettings(store).allowCommandVerify, false);
  const saved = writeGoalSettings(store, { defaultMaxTurns: 12, allowHttpVerify: false });
  assert.equal(saved.defaultMaxTurns, 12);
  assert.equal(saved.allowHttpVerify, false);
  assert.equal(readGoalSettings(store).defaultMaxTurns, 12);
});

test('ingestion settings clamp byte budgets', () => {
  const n = normalizeIngestionSettings({ maxBytes: 10, pageSizeChars: 50 });
  assert.ok(n.maxBytes >= 1024);
  assert.ok(n.pageSizeChars >= 1000);
  const store = kvStore();
  const saved = writeIngestionSettings(store, { enabled: false, gbkFallback: false });
  assert.equal(saved.enabled, false);
  assert.equal(saved.gbkFallback, false);
});

test('teams DAG settings reject shell-like gate commands', () => {
  const n = normalizeTeamsDagSettings({
    maxConcurrent: 99,
    workspaceSyncMode: 'nope',
    gates: { regression: { enabled: true, checker: 'command', command: 'rm -rf /' } }
  });
  assert.equal(n.maxConcurrent, 16);
  assert.equal(n.workspaceSyncMode, 'directory-copy');
  assert.equal(n.gates.regression.command, undefined);
  const ok = normalizeTeamsDagSettings({
    gates: { regression: { enabled: true, checker: 'command', command: 'npm' } }
  });
  assert.equal(ok.gates.regression.command, 'npm');
  assert.equal(normalizeTeamsDagSettings({ requireReview: false }).gates.review.enabled, false);
  const store = kvStore();
  const saved = writeTeamsDagSettings(store, { enabled: false });
  assert.equal(saved.enabled, false);
});

test('event-log settings write-once KV', () => {
  const store = kvStore();
  const saved = writeEventLogSettings(store, { enabled: false });
  assert.equal(saved.enabled, false);
});

test('skill disclosure settings persist via KV and env fallback', async () => {
  const {
    defaultSkillSettings,
    hasPersistedSkillSettings,
    normalizeSkillSettings,
    parseSkillDisclosureMode,
    readSkillSettings,
    resolveSkillDisclosureMode,
    writeSkillSettings
  } = await import('../dist/skills/skill-settings.js');

  assert.equal(defaultSkillSettings().disclosureMode, 'shortlist');
  assert.equal(parseSkillDisclosureMode('lazy'), 'lazy');
  assert.equal(parseSkillDisclosureMode('nope'), undefined);
  assert.equal(normalizeSkillSettings({ disclosureMode: 'full' }).disclosureMode, 'full');
  assert.equal(normalizeSkillSettings({ disclosureMode: 'nope' }).disclosureMode, 'shortlist');

  const store = kvStore();
  assert.equal(hasPersistedSkillSettings(store), false);
  assert.equal(readSkillSettings(store).disclosureMode, 'shortlist');
  assert.equal(resolveSkillDisclosureMode({ store, env: {} }), 'shortlist');
  assert.equal(
    resolveSkillDisclosureMode({ store, env: { RAW_AGENT_SKILL_ROUTING_MODE: 'legacy' } }),
    'full'
  );

  const saved = writeSkillSettings(store, { disclosureMode: 'lazy' });
  assert.equal(saved.disclosureMode, 'lazy');
  assert.equal(hasPersistedSkillSettings(store), true);
  assert.equal(readSkillSettings(store).disclosureMode, 'lazy');
  assert.equal(
    resolveSkillDisclosureMode({ store, env: { RAW_AGENT_SKILL_ROUTING_MODE: 'legacy' } }),
    'lazy'
  );
});
