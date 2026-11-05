import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERED_SMOKE_HARNESS_TIMEOUT_MS, PERFORMANCE_SPAWN_TIMEOUT_MS, SHARED_RUNNER_SMOKE_DRAIN_SECONDS, SHARED_RUNNER_SMOKE_READ_QUEUE_CAP, httpSoakOptionsFromArgv, smokeCoverageActive, smokeFixedReadPendingCap, smokeTimingForRun, soakTiming } from '../bot-release/http-fixture-timing.mjs';
import { performanceResult, performanceSoakArgs } from '../bot-release/soak-performance.mjs';

test('covered fixed-window reads keep the planned queue instead of one slot per client [AC:ci-http-fixture-timing#AC-1]', () => {
  assert.equal(smokeFixedReadPendingCap(20, false), 1);
  assert.equal(smokeFixedReadPendingCap(20, true), 4);
  assert.throws(() => smokeFixedReadPendingCap(0, true), /positive integer/);
  assert.throws(() => smokeFixedReadPendingCap(1.5, false), /positive integer/);
});

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

test('covered smoke keeps planned reads queued and waits out notification tails [AC:ci-http-fixture-timing#AC-4]', () => {
  const covered = smokeTimingForRun({ smoke: true, smokeSeconds: 8, readEveryMs: 25, readQueueCap: 20 }, { NODE_V8_COVERAGE: '/tmp/cov' });
  assert.equal(covered.configuration.drainSeconds, SHARED_RUNNER_SMOKE_DRAIN_SECONDS);
  assert.equal(covered.configuration.readQueueCap, SHARED_RUNNER_SMOKE_READ_QUEUE_CAP);
  assert.equal(covered.configuration.readEveryMs, 25);
  const local = smokeTimingForRun({ smoke: true, smokeSeconds: 8, readEveryMs: 25, readQueueCap: 20 }, {});
  assert.equal(local.configuration.drainSeconds, 30);
  assert.equal(local.configuration.readQueueCap, 20);
  const explicit = smokeTimingForRun({ smoke: true, smokeSeconds: 8, readEveryMs: 500, readQueueCap: 40, drainSeconds: 30 }, { NODE_V8_COVERAGE: '/tmp/cov' });
  assert.equal(explicit.configuration.drainSeconds, 30);
  assert.equal(explicit.configuration.readQueueCap, 40);
  const full = smokeTimingForRun({ smoke: false, smokeSeconds: 8, readEveryMs: 25, readQueueCap: 20 }, { NODE_V8_COVERAGE: '/tmp/cov' });
  assert.equal(full.configuration.drainSeconds, 120);
  assert.equal(full.configuration.readQueueCap, 20);
  assert.equal(smokeCoverageActive({ NODE_V8_COVERAGE: '/tmp/cov' }), true);
  assert.equal(smokeCoverageActive({}), false);
  assert.equal(smokeCoverageActive({ NODE_V8_COVERAGE: '' }), false);
  assert.equal(SHARED_RUNNER_SMOKE_READ_QUEUE_CAP, 80);
  assert.ok(2 + 8 + SHARED_RUNNER_SMOKE_DRAIN_SECONDS + 15 < COVERED_SMOKE_HARNESS_TIMEOUT_MS / 1000);
});
