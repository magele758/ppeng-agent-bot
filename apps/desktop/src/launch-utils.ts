import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_LOG_CAP = 8_000;

/** Drop non-string env values; Electron/Node child env maps must be string-only. */
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Env for `process.execPath` + `ELECTRON_RUN_AS_NODE=1`.
 * Forced last so a user `.env` cannot turn the child back into a GUI Electron.
 */
export function electronNodeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  return {
    ...sanitizeProcessEnv(base),
    ...overrides,
    ELECTRON_RUN_AS_NODE: '1'
  };
}

export function appendBoundedLog(prev: string, chunk: string, maxChars = DEFAULT_LOG_CAP): string {
  const next = `${prev}${chunk}`;
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

export function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join('\n');
}

export function formatChildFailure(args: {
  name: string;
  url?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  logs: string;
}): Error {
  const logTail = tailLines(args.logs, 40);
  const stillRunning = args.exitCode === null && !args.signal;
  const reason = stillRunning
    ? `${args.name} health check timeout${args.url ? ` (${args.url})` : ''}`
    : `${args.name} exited before becoming healthy (code ${args.exitCode ?? 'null'}${
        args.signal ? `, signal ${args.signal}` : ''
      })`;
  return new Error(logTail ? `${reason}\n\nLast output:\n${logTail}` : reason);
}

export type WaitHttpOptions = {
  url: string;
  maxAttempts: number;
  intervalMs: number;
  initialDelayMs: number;
  requestTimeoutMs: number;
  isAcceptable?: (status: number) => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  shouldAbort?: () => Error | null;
};

export async function waitForHttpOk(opts: WaitHttpOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isOk = opts.isAcceptable ?? ((status) => status >= 200 && status < 300);
  if (opts.initialDelayMs > 0) await sleep(opts.initialDelayMs);
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    const abortErr = opts.shouldAbort?.();
    if (abortErr) throw abortErr;
    try {
      const res = await fetchImpl(opts.url, { signal: AbortSignal.timeout(opts.requestTimeoutMs) });
      if (isOk(res.status)) return;
    } catch {
      // connection refused / request timeout — keep polling
    }
    if (attempt < opts.maxAttempts) await sleep(opts.intervalMs);
  }
  throw new Error(`Health check timeout: ${opts.url}`);
}

export type SupervisedChild = {
  process: ChildProcess;
  logs: () => string;
  takeExitError: (url?: string) => Error | null;
};

export function spawnElectronNode(opts: {
  execPath: string;
  script: string;
  cwd: string;
  env: Record<string, string>;
  name: string;
  ipc?: boolean;
  onLog?: (chunk: string) => void;
}): SupervisedChild {
  let logs = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exited = false;

  const child = spawn(opts.execPath, [opts.script], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const append = (buf: Buffer) => {
    const text = buf.toString();
    logs = appendBoundedLog(logs, text);
    opts.onLog?.(text);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (err) => {
    exited = true;
    if (exitCode === null) exitCode = 1;
    logs = appendBoundedLog(logs, `\n${err.stack ?? err.message}\n`);
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  return {
    process: child,
    logs: () => logs,
    takeExitError: (url?: string) => {
      if (!exited) return null;
      return formatChildFailure({
        name: opts.name,
        url,
        exitCode,
        signal: exitSignal,
        logs
      });
    }
  };
}
