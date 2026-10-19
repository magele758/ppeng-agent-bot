/**
 * Performance assertions that do not flake on a loaded machine.
 *
 * Wall-clock (`performance.now()`) deltas also count the time this process was
 * descheduled, so parallel suites, coverage and other jobs on the box push a
 * linear-time call past its budget. CPU time (`process.cpuUsage`) only counts
 * work this process did, and the best of a few runs drops one-off GC or JIT
 * pauses. A ReDoS / quadratic blow-up still costs orders of magnitude more CPU
 * than any of the budgets, so the assertions keep their teeth.
 */

/** Run `fn` `runs` times; return its last result and the smallest CPU time (ms) of a run. */
export function bestCpuMs(fn, runs = 3) {
  let ms = Infinity;
  let result;
  // Node's loader and compilation workers can consume process CPU while a
  // synchronous validator runs. Charge its executing thread when available;
  // retain the original process clock on older Node versions. Budgets and the
  // number of measurements remain unchanged.
  const clock = (process.threadCpuUsage ?? process.cpuUsage).bind(process);
  for (let i = 0; i < runs; i += 1) {
    const start = clock();
    result = fn();
    const { user, system } = clock(start);
    ms = Math.min(ms, (user + system) / 1000);
  }
  return { result, ms };
}
