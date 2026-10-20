/**
 * Shared spawn helpers for repo scripts.
 *
 * Mirrors `packages/core/src/sandbox/env-sanitizer.ts` (Tier 0) so dev /
 * supervisor / regression / integration scripts cannot accidentally pass
 * `LD_PRELOAD` / `NODE_OPTIONS` / etc into spawned processes. We deliberately
 * keep the keyset duplicated here (rather than `import` from packages/core/dist)
 * because some scripts run BEFORE the workspace is built.
 *
 * If you add an injection vector to the canonical core list, remember to
 * mirror it here.
 */
import { devNull } from 'node:os';

const SANDBOX_INJECTION_ENV_KEYS = new Set([
  // Linux dynamic linker
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // macOS dyld
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  // Node.js
  'NODE_OPTIONS',
  // Python / Java / Ruby / Perl
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
  'RUBYLIB', 'RUBYOPT', 'PERL5LIB', 'PERL5OPT',
  // Shell manipulation
  'BASH_ENV', 'ENV', 'CDPATH', 'IFS', 'PROMPT_COMMAND', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS'
]);

/** Strip all injection vectors from a base env. Pass-through everything else. */
export function sanitizeScriptEnv(base = process.env) {
  const out = { ...base };
  for (const k of Object.keys(out)) {
    if (SANDBOX_INJECTION_ENV_KEYS.has(k) || k.startsWith('BASH_FUNC_')) {
      delete out[k];
    }
  }
  return out;
}

const EPHEMERAL_DAEMON_STRIPPED_KEYS = [
  'RAW_AGENT_AUTH_TOKEN',
  'RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID',
  'RAW_AGENT_OAUTH_GOOGLE_CLIENT_SECRET',
  'RAW_AGENT_OAUTH_GITHUB_CLIENT_ID',
  'RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET',
  'RAW_AGENT_OAUTH_PUBLIC_ORIGIN'
];

/**
 * Env for harness-spawned (regression / integration / e2e / agent-eval)
 * daemons. They must be hermetic regardless of the developer's `.env`:
 * black-box probes call the daemon without Bearer and would 401, and host
 * self-heal / model settings would change behaviour between machines.
 *
 * Deleting keys is not enough — the daemon's `import 'dotenv/config'` re-reads
 * `<cwd>/.env` and would put them straight back. Pointing dotenv at the null
 * device makes that load a no-op; only the explicit shell env (CI vars) and
 * what the caller layers on top reach the daemon.
 * Real local `pnpm run dev` / supervised deploy intentionally keep `.env`.
 */
export function envForEphemeralDaemon(base = process.env) {
  const out = sanitizeScriptEnv(base);
  for (const k of EPHEMERAL_DAEMON_STRIPPED_KEYS) delete out[k];
  for (const k of Object.keys(out)) {
    if (k.startsWith('DOTENV_')) delete out[k];
  }
  out.DOTENV_CONFIG_PATH = devNull;
  return out;
}

/**
 * Cross-platform binary resolver — npm/npx are `.cmd` on Windows.
 * Use as `spawn(resolveBin('npm'), [...], { shell: false })` to avoid the
 * `shell: true` quoting trap on Windows that mangles arguments containing
 * spaces.
 */
export function resolveBin(name) {
  if (process.platform !== 'win32') return name;
  // Node's child_process needs the explicit .cmd suffix when shell:false.
  if (name === 'npm') return 'npm.cmd';
  if (name === 'npx') return 'npx.cmd';
  if (name === 'yarn') return 'yarn.cmd';
  if (name === 'pnpm') return 'pnpm.cmd';
  return name;
}

/** Bearer headers when RAW_AGENT_AUTH_TOKEN is set (Candidate / secured daemon). */
export function daemonAuthHeaders(extra = {}) {
  const token = process.env.RAW_AGENT_AUTH_TOKEN?.trim();
  if (!token) return { ...extra };
  return { ...extra, Authorization: `Bearer ${token}` };
}
