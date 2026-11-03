/** Shared-runner smoke clocks. Full-protocol thresholds stay in workload.v1.json. */

/** A coverage-slow HTTP write can outlast the 1000ms search budget. Smoke only. */
export const SMOKE_COMPLETION_GRACE_MS = 15_000;
/**
 * Result-notification turns keep a session running after offered work is already
 * terminal. 90s is inside the 180s performance-process budget.
 */
export const SHARED_RUNNER_SMOKE_DRAIN_SECONDS = 90;
/**
 * Covered drivers still plan 40 reads/s. On the shared runner the read p95
 * was about 1s and two planned reads missed a queue of 20. Depth 80 holds
 * that spike and still drops reads once the driver is two seconds behind.
 */
export const SHARED_RUNNER_SMOKE_READ_QUEUE_CAP = 80;
export const PERFORMANCE_SPAWN_TIMEOUT_MS = 180_000;
/** Warmup, measurement, the 90s drain, and shutdown slack. */
export const COVERED_SMOKE_HARNESS_TIMEOUT_MS = 180_000;

export function smokeCoverageActive(env = process.env) {
  const value = env.NODE_V8_COVERAGE;
  return typeof value === 'string' && value.length > 0;
}

export function completionGraceMs(smoke, searchP95) {
  if (!(searchP95 > 0) || !Number.isFinite(searchP95)) throw new Error('Search p95 grace must be a positive finite duration');
  return smoke ? SMOKE_COMPLETION_GRACE_MS : searchP95;
}

export function resolveSmokeDrainSeconds(drainSeconds, coverage = false) {
  if (drainSeconds === undefined) return coverage ? SHARED_RUNNER_SMOKE_DRAIN_SECONDS : 30;
  if (!Number.isInteger(drainSeconds) || drainSeconds < 30 || drainSeconds > 120) {
    throw new Error('Smoke drain must be an integer from 30 to 120 seconds');
  }
  return drainSeconds;
}

export function resolveSmokeReadQueueCap(readQueueCap, coverage = false) {
  if (!Number.isInteger(readQueueCap) || readQueueCap < 20) {
    throw new Error('readQueueCap must be an integer of at least 20');
  }
  if (coverage && readQueueCap === 20) return SHARED_RUNNER_SMOKE_READ_QUEUE_CAP;
  return readQueueCap;
}

export function soakTiming(smoke, smokeSeconds, readEveryMs, readQueueCap, drainSeconds, coverage = false) {
  return {
    mode: smoke ? 'compressed-harness-fixture' : 'full-http-soak',
    configuration: {
      warmupSeconds: smoke ? 2 : 1800,
      measurementSeconds: smoke ? smokeSeconds : 86400,
      drainSeconds: smoke ? resolveSmokeDrainSeconds(drainSeconds, coverage) : 120,
      burstEverySeconds: smoke ? 6 : 3600,
      burstDurationSeconds: smoke ? 1 : 60,
      readEveryMs,
      readQueueCap: smoke ? resolveSmokeReadQueueCap(readQueueCap, coverage) : readQueueCap,
    },
  };
}

export function smokeTimingForRun(options, env = process.env) {
  return soakTiming(
    options.smoke,
    options.smokeSeconds,
    options.readEveryMs,
    options.readQueueCap,
    options.drainSeconds,
    Boolean(options.smoke) && smokeCoverageActive(env),
  );
}

export function httpSoakOptionsFromArgv(args) {
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  return {
    smoke: args.includes('--smoke'),
    smokeSeconds: Number(option('--smoke-seconds', 8)),
    out: option('--out', 'test-results/bot-http-soak.json'),
    readEveryMs: Number(option('--read-every-ms', 25)),
    readQueueCap: Number(option('--read-queue-cap', 20)),
    drainSeconds: args.includes('--drain-seconds') ? Number(option('--drain-seconds')) : undefined,
  };
}
