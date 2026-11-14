import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { modelProviderRoutes } from '../dist/routes/model-providers.js';

const explicitOff = {
  enabled: false,
  enablementSource: 'explicit_off',
  roles: { plannerModel: 'planner/model', executorModel: 'executor/model' },
  caps: { perTurn: 2, perSession: 4 },
};

test('routing save keeps an explicit close and new chats copy it without a manual metadata write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-routing-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'handoff-routing',
      async runTurn() {
        return { stopReason: 'end' as const, assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      },
    },
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      return text ? JSON.parse(text) : {};
    },
  }).addAll(modelProviderRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then(found => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch(error => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/api/model-providers/routing`;
    const patch = async (capabilityTiers: unknown) => fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilityTiers }),
    });

    assert.equal((await patch(explicitOff)).status, 200);
    const copied = runtime.createChatSession({ title: 'copied' });
    assert.equal(copied.metadata?.capabilityTiers?.enablementSource, 'explicit_off');
    assert.equal(copied.metadata?.capabilityTiers?.roles?.plannerModel, 'planner/model');
    assert.equal(copied.metadata?.capabilityTiers?.roles?.executorModel, 'executor/model');
    assert.equal(copied.metadata?.capabilityTiers?.caps?.perTurn, 2);
    assert.equal(copied.metadata?.capabilityTiers?.caps?.perSession, 4);

    assert.equal((await patch({ enabled: false, enablementSource: 'parser_default' })).status, 200);
    const kept = runtime.createChatSession({ title: 'kept' });
    assert.equal(kept.metadata?.capabilityTiers?.enablementSource, 'explicit_off');
    assert.equal(kept.metadata?.capabilityTiers?.enabled, false);
    assert.equal(kept.metadata?.capabilityTiers?.roles?.plannerModel, 'planner/model');
    assert.equal(kept.metadata?.capabilityTiers?.roles?.executorModel, 'executor/model');
    assert.equal(kept.metadata?.capabilityTiers?.caps?.perSession, 4);

    const supplied = runtime.createChatSession({
      title: 'supplied',
      metadata: {
        capabilityTiers: { enabled: true, enablementSource: 'explicit_on', roles: { plannerModel: 'other/model' } },
      },
    });
    assert.equal(supplied.metadata?.capabilityTiers?.enablementSource, 'explicit_on');
    assert.equal(supplied.metadata?.capabilityTiers?.roles?.plannerModel, 'other/model');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
