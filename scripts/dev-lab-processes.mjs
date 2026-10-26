import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

const POSIX = process.platform !== 'win32';
const EXIT_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function listProcessGroups() {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8', env: sanitizeScriptEnv(), timeout: 1000, maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error('Unable to inspect process groups');
  return result.stdout;
}

export function groupExists(child, { kill = process.kill, listGroups = listProcessGroups } = {}) {
  if (!child.pid) return false;
  if (!POSIX) return child.exitCode === null && child.signalCode === null;
  try { kill(-child.pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') {
      // macOS can report EPERM while the last group member is being reaped.
      // Do not hide real permission failures: only accept a verified empty or zombie-only group.
      try {
        const members = listGroups().trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
        if (members.some(([pid, pgid, state]) => !/^\d+$/.test(pid) || !/^\d+$/.test(pgid) || !state)) throw new Error('Invalid process group listing');
        if (!members.some(([, pgid, state]) => Number(pgid) === child.pid && !state?.startsWith('Z'))) return false;
      } catch { /* An inconclusive inspection must retain the original error. */ }
    }
    throw error;
  }
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (POSIX) process.kill(-child.pid, signal);
    else {
      // Windows has no POSIX process groups. Kill the tree while its leader
      // still exists, rather than losing the descendants by killing it first.
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', env: sanitizeScriptEnv(), timeout: 5000
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && groupExists(child)) throw new Error(`taskkill failed for ${child.pid}`);
    }
  } catch (error) {
    if (error.code === 'ESRCH' || (error.code === 'EPERM' && !groupExists(child))) return;
    throw error;
  }
}

async function stopGroup(entry, graceMs) {
  const { child } = entry;
  if (!child.pid) return;
  // The wrapper exiting does not mean its process group is empty.
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupExists(child) && Date.now() < deadline) await delay(25);
  if (groupExists(child)) {
    signalGroup(child, 'SIGKILL');
    const killedDeadline = Date.now() + 1000;
    while (groupExists(child) && Date.now() < killedDeadline) await delay(25);
    // Linux may retain orphan zombies until PID 1 reaps them; they hold no ports.
  }
  await entry.done;
}

/** Own only the process groups created here, including the build task. */
export async function runDevProcesses({ cwd, build, services, onReady = () => {}, onStop = () => {} }, { graceMs = 3000 } = {}) {
  const entries = new Set();
  let stopping = false;
  let finish;
  const outcome = new Promise(resolve => { finish = resolve; });
  const stop = code => {
    if (stopping) return;
    stopping = true;
    finish(code);
  };
  const handlers = new Map(Object.entries(EXIT_SIGNALS).map(([signal, code]) => [signal, () => stop(code)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const start = spec => {
    const child = spawn(spec.command, spec.args, {
      cwd, env: sanitizeScriptEnv(spec.env), stdio: 'inherit', shell: false, detached: POSIX
    });
    const entry = { child, done: new Promise(resolve => {
      child.once('error', error => { console.error(`[dev-lab] ${spec.name}: ${error.message}`); resolve(1); });
      child.once('exit', (code, signal) => resolve(code ?? EXIT_SIGNALS[signal] ?? 1));
    }) };
    entries.add(entry);
    return entry;
  };
  try {
    const compiler = start(build);
    const buildCode = await Promise.race([compiler.done, outcome]);
    if (stopping || buildCode !== 0) return buildCode;
    await stopGroup(compiler, graceMs);
    entries.delete(compiler);
    if (stopping) return await outcome;
    for (const spec of services) {
      const entry = start(spec);
      void entry.done.then(code => {
        if (!stopping && code !== 0) console.error(`[dev-lab] ${spec.name} exited with ${code}`);
        stop(code);
      });
    }
    onReady();
    return await outcome;
  } finally {
    stopping = true;
    try {
      onStop();
    } finally {
      try {
        const results = await Promise.allSettled([...entries].map(entry => stopGroup(entry, graceMs)));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Failed to clean up development processes');
      }
      finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
    }
  }
}
