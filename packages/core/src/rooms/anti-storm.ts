/** How long a saved per-minute reply cap looks back. */
export const REPLY_WINDOW_MS = 60_000;

/** Drop timestamps that are outside the current window or unreadable. */
export function pruneReplyTimes(times: readonly string[], now: number): string[] {
  return times.filter(value => {
    const at = Date.parse(value);
    return Number.isFinite(at) && now - at < REPLY_WINDOW_MS && now - at >= 0;
  });
}

/**
 * Whether another member may be arranged.
 * `reserved` counts speakers already chosen for the current batch but not posted yet.
 */
export function rateLimitDecision(
  times: readonly string[],
  cap: number,
  now: number,
  reserved = 0
): { allow: boolean; resumeAt?: string } {
  const recent = pruneReplyTimes(times, now);
  if (recent.length + reserved < cap) return { allow: true };
  const oldest = recent.reduce<number>((min, value) => Math.min(min, Date.parse(value)), now);
  return { allow: false, resumeAt: new Date(oldest + REPLY_WINDOW_MS).toISOString() };
}
