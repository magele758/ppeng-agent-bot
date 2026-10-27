import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasPersistedSessionRecapSettings,
  readSessionRecapSettings,
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
