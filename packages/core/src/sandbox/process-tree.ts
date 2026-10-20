/**
 * Process-tree termination for spawned shells.
 *
 * `child.kill()` only signals the direct child: `bash -c "sleep 999"` (or
 * `pnpm run …`, `bwrap … bash -c …`) leaves its descendants running after a
 * timeout. On POSIX we spawn the child as its own process-group leader
 * (`detached: true`) and signal the whole group with `process.kill(-pid)`.
 */

import { spawnSync, type ChildProcess } from 'node:child_process';

/** How long a tree gets between SIGTERM and SIGKILL. */
export const TREE_KILL_GRACE_MS = 2_000;

/** Spawn options that make {@link signalProcessTree} reach every descendant. */
export function treeKillSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

/**
 * Signal the child's whole process group (POSIX) or tree (Windows).
 * The child must have been spawned with {@link treeKillSpawnOptions}.
 * A group that is already gone is not an error.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH: every member of the group already exited */
  }
}

/**
 * SIGTERM the tree now and SIGKILL whatever is left after `graceMs`.
 *
 * The SIGKILL is not cancelled when the leader exits: a descendant that traps
 * SIGTERM and no longer holds the stdio pipes would otherwise survive. The
 * timer is unref'd so it never keeps the host process alive.
 */
export function terminateProcessTree(child: ChildProcess, graceMs: number = TREE_KILL_GRACE_MS): void {
  signalProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), Math.max(0, graceMs));
  timer.unref?.();
}
