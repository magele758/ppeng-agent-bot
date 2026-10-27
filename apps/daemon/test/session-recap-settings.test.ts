import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SESSION_RECAP_SETTINGS_KEY,
  hasPersistedSessionRecapSettings,
  readSessionRecapSettings,
  recapFeatureEnabled,
  writeSessionRecapSettings,
  type SessionRecapSettingsStore
} from '../src/session-recap-settings.ts';

function memoryStore(): SessionRecapSettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    getDaemonControl<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    setDaemonControl(key: string, value: unknown) {
      values.set(key, value);
    }
  };
}

test('自动回顾默认开着，关掉后仍保持关闭 [AC:session-recap#AC-4]', () => {
  const store = memoryStore();
  assert.equal(hasPersistedSessionRecapSettings(store), false);
  assert.equal(readSessionRecapSettings(store).enabled, true);

  const saved = writeSessionRecapSettings(store, { enabled: false }, '2026-10-27T00:00:00.000Z');
  assert.equal(saved.enabled, false);
  assert.equal(saved.updatedAt, '2026-10-27T00:00:00.000Z');
  assert.equal(hasPersistedSessionRecapSettings(store), true);
  assert.equal(readSessionRecapSettings(store).enabled, false);
  assert.equal(writeSessionRecapSettings(store, {}, '2026-10-27T01:00:00.000Z').enabled, false);

  const policy = readFileSync(new URL('../src/access/policy.ts', import.meta.url), 'utf8');
  assert.match(policy, /\['GET \/api\/session-recap\/settings', AUTHENTICATED\]/);
  assert.match(policy, /\['PATCH \/api\/session-recap\/settings', ADMIN\]/);
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(app, /sessionRecapRoutes\(runtime\)/);
});

test('整段回顾默认开着，关掉后不写回顾，自动选择还在 [AC:session-recap#AC-5]', () => {
  const store = memoryStore();
  const fresh = readSessionRecapSettings(store);
  assert.equal(fresh.active, true);
  assert.equal(recapFeatureEnabled(fresh), true);

  store.setDaemonControl(SESSION_RECAP_SETTINGS_KEY, {
    enabled: false,
    updatedAt: '2026-10-26T00:00:00.000Z'
  });
  const legacy = readSessionRecapSettings(store);
  assert.equal(legacy.active, true);
  assert.equal(legacy.enabled, false);

  const off = writeSessionRecapSettings(store, { active: false }, '2026-10-27T02:00:00.000Z');
  assert.equal(off.active, false);
  assert.equal(off.enabled, false);
  assert.equal(recapFeatureEnabled(off), false);
  const kept = writeSessionRecapSettings(store, {}, '2026-10-27T03:00:00.000Z');
  assert.equal(kept.active, false);
  assert.equal(kept.enabled, false);

  const autoOnly = writeSessionRecapSettings(store, { active: true, enabled: true }, '2026-10-27T04:00:00.000Z');
  assert.equal(autoOnly.active, true);
  assert.equal(autoOnly.enabled, true);
  const autoOff = writeSessionRecapSettings(store, { enabled: false }, '2026-10-27T05:00:00.000Z');
  assert.equal(autoOff.active, true);
  assert.equal(autoOff.enabled, false);
  assert.equal(recapFeatureEnabled(autoOff), true);

  const route = readFileSync(new URL('../src/routes/session-recap.ts', import.meta.url), 'utf8');
  const guard = route.indexOf('if (!recapFeatureEnabled(');
  const compose = route.indexOf('composeSessionRecap({');
  assert.ok(guard > 0 && compose > guard);
  assert.match(route, /active must be a boolean/);
});
