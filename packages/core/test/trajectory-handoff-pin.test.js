import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { readModelCatalog, writeModelCatalog } from '../dist/model/provider-catalog.js';
import { resolvePinnedRoleAdapter, selectOriginalModelPin } from '../dist/model/role-pinning.js';

test('explicit handoff persists the primary catalog model and resolves the role through it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-pin-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const previous = process.env.RAW_AGENT_VL_MODEL_NAME;
  process.env.RAW_AGENT_VL_MODEL_NAME = 'vl-model';
  try {
    writeModelCatalog(store, {
      providers: [
        {
          id: 'guess',
          name: 'Guess',
          kind: 'heuristic',
          baseUrl: '',
          apiKey: '',
          models: [{ id: 'guess-model', enabled: true }],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: [
            { id: 'vl-model', enabled: true },
            { id: 'fallback-model', enabled: true },
            { id: 'disabled-model', enabled: false },
            { id: 'primary-model', enabled: true },
          ],
        },
      ],
      defaultRef: { providerId: 'openai', modelId: 'vl-model' },
      fallbackRefs: [{ providerId: 'openai', modelId: 'fallback-model' }],
      updatedAt: new Date().toISOString(),
    });
    const session = store.createSession({
      title: 'pin',
      mode: 'chat',
      agentId: 'general',
      metadata: {
        capabilityTiers: {
          enabled: true,
          enablementSource: 'explicit_on',
          roles: { plannerModel: 'missing/planner', executorModel: 'missing/executor' },
        },
        handoffRole: 'executor',
        modelRef: { providerId: 'openai', modelId: 'fallback-model' },
      },
    });
    const catalog = readModelCatalog(store);
    const pin = selectOriginalModelPin({ catalog, metadata: session.metadata, env: process.env });
    assert.equal(pin, 'openai/primary-model');
    store.updateSession(session.id, { metadata: { ...session.metadata, pinnedSessionModel: pin } });
    const pinned = store.getSession(session.id);
    assert.equal(pinned.metadata.pinnedSessionModel, 'openai/primary-model');
    const resolved = resolvePinnedRoleAdapter({ session: pinned, catalog, env: process.env });
    assert.equal(resolved.rolePinFailed, false);
    assert.equal(resolved.adapter.modelName, 'openai/primary-model');
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_VL_MODEL_NAME;
    else process.env.RAW_AGENT_VL_MODEL_NAME = previous;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
