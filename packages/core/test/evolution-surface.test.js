import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVOLUTION_DISABLED_CODE,
  EVOLUTION_SURFACE_ENABLED,
  considerEvolutionSchedule,
  evolutionStartHttpResult
} from '../src/evolution/surface.ts';
import { runScheduler } from '../dist/runtime/scheduler-host.js';

test('Evolution surface switch defaults off and does not launch [AC:ops-console#AC-9]', () => {
  assert.equal(EVOLUTION_SURFACE_ENABLED, false);
  for (const reason of ['boot', 'timer', 'http', 'cli']) {
    const calls = [];
    const decision = considerEvolutionSchedule({
      reason,
      launch: (why) => calls.push(why)
    });
    assert.equal(decision.started, false);
    assert.equal(decision.code, EVOLUTION_DISABLED_CODE);
    assert.deepEqual(calls, []);
  }
  const http = evolutionStartHttpResult();
  assert.equal(http.status, 409);
  assert.equal(http.body.code, EVOLUTION_DISABLED_CODE);
});

test('scheduler tick does not start Evolution [AC:ops-console#AC-9]', async () => {
  const calls = [];
  const host = {
    store: {
      listApprovals() {
        return [];
      }
    },
    stateDir: '/tmp',
    log: { warn() {}, info() {} },
    cronStore: { dueJobs: () => [] },
    setCronStore() {},
    selfHeal: { async processRuns() {} },
    swarmExecutor: { async tick() {} },
    orchestrationEngine: { async tick() {} },
    autonomousScheduler: { async tick() {} },
    async runSession() {},
    launchEvolution(reason) {
      calls.push(reason);
    }
  };
  await runScheduler(host);
  assert.deepEqual(calls, []);
});
