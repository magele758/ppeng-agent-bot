import test from 'node:test';
import assert from 'node:assert/strict';
import { PERFORMANCE_SPAWN_TIMEOUT_MS, SHARED_RUNNER_SMOKE_DRAIN_SECONDS, httpSoakOptionsFromArgv, soakTiming } from '../bot-release/http-fixture-timing.mjs';
import { performanceResult, performanceSoakArgs } from '../bot-release/soak-performance.mjs';

test('shared runner smoke drain waits out notification tails without moving local or full-protocol drains [AC:ci-http-fixture-timing#AC-3]', () => {
  assert.equal(SHARED_RUNNER_SMOKE_DRAIN_SECONDS, 90);
  const remote = httpSoakOptionsFromArgv(['--smoke', '--read-every-ms', '500', '--read-queue-cap', '40', '--drain-seconds', '90']);
  assert.equal(soakTiming(remote.smoke, remote.smokeSeconds, remote.readEveryMs, remote.readQueueCap, remote.drainSeconds).configuration.drainSeconds, 90);
  assert.equal(soakTiming(true, 8, 25, 20).configuration.drainSeconds, 30);
  assert.equal(soakTiming(false, 8, 25, 20, 90).configuration.drainSeconds, 120);
  assert.throws(() => soakTiming(true, 8, 500, 40, 29), /30 to 120/);
  assert.throws(() => soakTiming(true, 8, 500, 40, 121), /30 to 120/);
  const args = performanceSoakArgs('github-actions', 'test-results/soak-performance/http-soak.json');
  assert.equal(args[args.indexOf('--drain-seconds') + 1], '90');
  assert.equal(args[args.indexOf('--read-every-ms') + 1], '500');
  assert.equal(args[args.indexOf('--read-queue-cap') + 1], '40');
  assert.equal(performanceSoakArgs('local', 'out.json').includes('--drain-seconds'), false);
  assert.ok(2 + 8 + 20 + SHARED_RUNNER_SMOKE_DRAIN_SECONDS < PERFORMANCE_SPAWN_TIMEOUT_MS / 1000);
  const latency = Object.fromEntries(['page', 'status', 'search', 'receive'].map(key => [key, { count: 34, p95Ms: 8000 }]));
  const report = { fixturePassed: true, status: 'completed', latency };
  assert.equal(performanceResult(report, 'github-actions').passed, true);
  assert.equal(performanceResult(report, 'github-actions').checks.find(check => check.name === 'receive').thresholdMs, 8000);
  assert.equal(performanceResult({ ...report, fixturePassed: false }, 'github-actions').passed, false);
  assert.equal(performanceResult({ ...report, latency: { ...latency, receive: { count: 34, p95Ms: 8001 } } }, 'github-actions').passed, false);
  assert.throws(() => performanceSoakArgs('unknown', 'out.json'), /profile/);
});
