/** Shared-runner smoke clocks. Full-protocol thresholds stay in workload.v1.json. */

/** A coverage-slow HTTP write can outlast the 1000ms search budget. Smoke only. */
export const SMOKE_COMPLETION_GRACE_MS = 15_000;
/**
 * Result-notification turns keep a session running after offered work is already
 * terminal. 90s is inside the 180s performance-process budget.
 */
export const SHARED_RUNNER_SMOKE_DRAIN_SECONDS = 90;
export const PERFORMANCE_SPAWN_TIMEOUT_MS = 180_000;

export function completionGraceMs(smoke, searchP95) {
  if (!(searchP95 > 0) || !Number.isFinite(searchP95)) throw new Error('Search p95 grace must be a positive finite duration');
  return smoke ? SMOKE_COMPLETION_GRACE_MS : searchP95;
}

export function resolveSmokeDrainSeconds(drainSeconds) {
  if (drainSeconds === undefined) return 30;
  if (!Number.isInteger(drainSeconds) || drainSeconds < 30 || drainSeconds > 120) {
    throw new Error('Smoke drain must be an integer from 30 to 120 seconds');
  }
  return drainSeconds;
}

export function soakTiming(smoke, smokeSeconds, readEveryMs, readQueueCap, drainSeconds) {
  return {
    mode: smoke ? 'compressed-harness-fixture' : 'full-http-soak',
    configuration: {
      warmupSeconds: smoke ? 2 : 1800,
      measurementSeconds: smoke ? smokeSeconds : 86400,
      drainSeconds: smoke ? resolveSmokeDrainSeconds(drainSeconds) : 120,
      burstEverySeconds: smoke ? 6 : 3600,
      burstDurationSeconds: smoke ? 1 : 60,
      readEveryMs,
      readQueueCap,
    },
  };
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
