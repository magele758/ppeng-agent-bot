/**
 * Zero-token gate for a bot routine. Runs before any model turn.
 * Only a strict `{ "wakeAgent": false }` skips the model; anything else wakes.
 * Scripts use Tier-0 env sanitization (direct sandbox) so they can see host state.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SandboxManager } from '../sandbox/os-sandbox.js';

const PRECHECK_TIMEOUT_MS = 15_000;
const MAX_STDOUT = 65_536;

export interface RoutinePrecheck {
  kind: 'script' | 'predicate';
  source: string;
}

export interface PrecheckResult {
  wakeAgent: boolean;
  reason?: string;
}

/** Last non-empty line. `false` only when `wakeAgent` is the boolean false. */
export function parseWakeGate(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return true;
  try {
    const parsed = JSON.parse(last) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    return (parsed as { wakeAgent?: unknown }).wakeAgent !== false;
  } catch {
    return true;
  }
}

export function readStoredPrecheck(metadata: Record<string, unknown> | undefined): RoutinePrecheck | undefined {
  const raw = metadata?.precheck;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  const source = (raw as { source?: unknown }).source;
  if ((kind !== 'script' && kind !== 'predicate') || typeof source !== 'string' || !source.trim()) {
    return undefined;
  }
  return { kind, source: source.trim() };
}

function filePredicateWakes(source: string, cwd: string): boolean | undefined {
  const match = source.match(/^file:\s*([\s\S]+)$/i);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  if (!raw) return true;
  const path = isAbsolute(raw) ? raw : join(cwd, raw);
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function runPrecheckScript(
  command: string,
  cwd: string,
  spawn?: { env?: NodeJS.ProcessEnv; denyEnv?: string[] }
): Promise<string> {
  const sandbox = new SandboxManager('direct');
  const overrides = spawn?.env && Object.keys(spawn.env).length > 0 ? spawn.env : undefined;
  const extraDenylist = spawn?.denyEnv?.filter(Boolean);
  const result = await sandbox.execute(command, cwd, {
    timeoutMs: PRECHECK_TIMEOUT_MS,
    allowNetwork: true,
    ...(overrides || extraDenylist?.length
      ? {
          envOptions: {
            ...(overrides ? { overrides } : {}),
            ...(extraDenylist?.length ? { extraDenylist } : {})
          }
        }
      : {})
  });
  if(result.code!==0)throw new Error(`Precheck exited ${result.code??result.signal??'unknown'}`);
  return (result.stdout ?? '').slice(0, MAX_STDOUT);
}

/**
 * `env` is given to script children only (for example a path to the event file).
 * It is not spliced into the command string. `parseWakeGate` is unchanged.
 */
export async function evaluateRoutinePrecheck(
  precheck: RoutinePrecheck,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; denyEnv?: string[] }
): Promise<PrecheckResult> {
  const cwd = opts?.cwd ?? process.cwd();
  if (precheck.kind === 'predicate') {
    const fileGate = filePredicateWakes(precheck.source, cwd);
    if (fileGate !== undefined) return { wakeAgent: fileGate };
    return { wakeAgent: parseWakeGate(precheck.source) };
  }
  if (precheck.kind === 'script') {
    try {
      const stdout = await runPrecheckScript(precheck.source, cwd, {
        env: opts?.env,
        denyEnv: opts?.denyEnv
      });
      return { wakeAgent: parseWakeGate(stdout) };
    } catch (error) {
      return { wakeAgent: true, reason:error instanceof Error?error.message:String(error) };
    }
  }
  const neverKind: never = precheck.kind;
  throw new Error(`unknown precheck kind ${String(neverKind)}`);
}
