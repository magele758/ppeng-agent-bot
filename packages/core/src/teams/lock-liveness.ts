/**
 * Shared lock-owner liveness. A live pid (kill 0 succeeds, or EPERM) is never
 * stale. Mtime age is only a crash leftover when the pid is dead or unparseable.
 */

export function lockPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Leading `pid:…` token. Undefined when the body has no positive integer pid. */
export function parseLockPid(body: string): number | undefined {
  const pid = Number(body.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

/**
 * True when the recorded owner is gone or the token has no pid.
 * A live owner (including our own pid and EPERM) is never dead.
 */
export function lockOwnerDead(body: string): boolean {
  const pid = parseLockPid(body);
  if (pid === undefined) return true;
  return !lockPidAlive(pid);
}
