import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSubagentOutcome } from '../dist/runtime/spawn-host.js';

test('a planner child keeps the handoff ceiling and drops the parent model pin', async () => {
  let created;
  const parent = {
    id: 'parent',
    metadata: {
      capabilityTiers: {
        enabled: true,
        enablementSource: 'explicit_on',
        roles: { plannerModel: 'planner/model' },
      },
      handoffState: 'planner_readonly',
      handoffRole: 'planner',
      originalPerms: ['read'],
      modelOverride: 'executor/current',
    },
  };
  const host = {
    store: {
      getAgent() { return undefined; },
      createSession(input) {
        created = input;
        return { id: 'child', status: 'idle', metadata: input.metadata };
      },
      copySessionMemory() {},
      appendMessage() {},
      foldMessages() { return []; },
      getSession(id) { return id === parent.id ? parent : { id, status: 'idle' }; },
    },
    async runSession() {},
  };
  const result = await spawnSubagentOutcome(host, {
    session: parent,
    agent: { id: 'general', name: 'General', role: 'assistant' },
  }, {
    prompt: 'plan the work',
    model: 'executor/override',
  });
  assert.equal(result.ok, true);
  assert.equal(created.metadata.capabilityTiers.enablementSource, 'explicit_on');
  assert.equal(created.metadata.handoffState, 'planner_readonly');
  assert.equal(created.metadata.handoffRole, 'planner');
  assert.deepEqual(created.metadata.originalPerms, ['read']);
  assert.equal(created.metadata.modelOverride, undefined);
});

test('a child follows the stored parent when the spawn context is still executor', async () => {
  let created;
  const stale = {
    id: 'parent',
    metadata: {
      capabilityTiers: {
        enabled: true,
        enablementSource: 'explicit_on',
        roles: { plannerModel: 'planner/model', executorModel: 'executor/model' },
      },
      handoffState: 'executor_write',
      handoffRole: 'executor',
      originalPerms: ['write'],
      modelOverride: 'executor/current',
    },
  };
  const live = {
    id: 'parent',
    metadata: {
      capabilityTiers: stale.metadata.capabilityTiers,
      handoffState: 'planner_readonly',
      handoffRole: 'planner',
      originalPerms: ['read'],
    },
  };
  const host = {
    store: {
      getAgent() { return undefined; },
      createSession(input) {
        created = input;
        return { id: 'child', status: 'idle', metadata: input.metadata };
      },
      copySessionMemory() {},
      appendMessage() {},
      foldMessages() { return []; },
      getSession(id) { return id === live.id ? live : { id, status: 'idle' }; },
    },
    async runSession() {},
  };
  const result = await spawnSubagentOutcome(host, {
    session: stale,
    agent: { id: 'general', name: 'General', role: 'assistant' },
  }, {
    prompt: 'plan the work',
    model: 'executor/override',
  });
  assert.equal(result.ok, true);
  assert.equal(created.metadata.handoffRole, 'planner');
  assert.equal(created.metadata.handoffState, 'planner_readonly');
  assert.deepEqual(created.metadata.originalPerms, ['read']);
  assert.equal(created.metadata.modelOverride, undefined);
});
