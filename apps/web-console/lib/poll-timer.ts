/** Timer-driven reads: one at a time, paused or slowed while the tab is hidden. */

export interface PollClock {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface VisibilitySource {
  hidden: () => boolean;
  subscribe: (changed: () => void) => () => void;
}

/** Tab visibility. Without a document (tests, server render) the page counts as visible. */
export const pageVisibility: VisibilitySource = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (changed) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }
};

const systemClock: PollClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface PollTimerOptions {
  run: () => unknown;
  /** Wait after one read ends before the next starts. Read each time, so it can follow live state. */
  delayMs: () => number;
  /** Wait while the tab is hidden. Omit to stop reading until the tab is shown again. */
  hiddenDelayMs?: () => number;
  /** Read once right away. Default true. */
  immediate?: boolean;
  /** Reads right away when the callback fires, e.g. the watched session started running. */
  wake?: (readNow: () => void) => () => void;
  visibility?: VisibilitySource;
  clock?: PollClock;
}

/** Wait for the next read, or `undefined` when reading is paused. */
export function nextPollDelay(hidden: boolean, delayMs: () => number, hiddenDelayMs?: () => number): number | undefined {
  if (!hidden) return delayMs();
  return hiddenDelayMs?.();
}

/**
 * Repeats `run`, waiting `delayMs()` after each one settles, so a slow answer
 * never has a second copy stacked behind it. Showing the tab again reads at once.
 */
export function startPollTimer(options: PollTimerOptions): () => void {
  const visibility = options.visibility ?? pageVisibility;
  const clock = options.clock ?? systemClock;
  let stopped = false;
  let running = false;
  let handle: unknown;

  const cancel = () => {
    if (handle !== undefined) clock.clearTimeout(handle);
    handle = undefined;
  };
  const schedule = () => {
    cancel();
    if (stopped) return;
    const ms = nextPollDelay(visibility.hidden(), options.delayMs, options.hiddenDelayMs);
    if (ms !== undefined) handle = clock.setTimeout(fire, ms);
  };
  const fire = () => {
    cancel();
    if (stopped || running) return;
    running = true;
    void Promise.resolve()
      .then(options.run)
      .catch(() => {})
      .finally(() => {
        running = false;
        schedule();
      });
  };
  const onVisibility = () => {
    if (visibility.hidden()) schedule();
    else fire();
  };

  const stopVisibility = visibility.subscribe(onVisibility);
  const stopWake = options.wake?.(fire);
  if (options.immediate === false) schedule();
  else fire();

  return () => {
    stopped = true;
    cancel();
    stopVisibility();
    stopWake?.();
  };
}

export interface ReadGate {
  /** True when a read should go out now; records the time when it says yes. */
  due: (hasPendingWrite: boolean) => boolean;
}

/**
 * For sync loops that both push local edits and pull remote ones. A local edit
 * goes out on the next check; pulling other browsers' edits waits `everyMs`
 * and stops while the tab is hidden.
 */
export function createReadGate(
  everyMs: number,
  now: () => number = () => Date.now(),
  hidden: () => boolean = pageVisibility.hidden
): ReadGate {
  let lastAt: number | undefined;
  return {
    due(hasPendingWrite) {
      const first = lastAt === undefined;
      const elapsed = !first && !hidden() && now() - lastAt! >= everyMs;
      if (!first && !hasPendingWrite && !elapsed) return false;
      lastAt = now();
      return true;
    }
  };
}
