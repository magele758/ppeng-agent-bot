/**
 * Tool-result redaction: strip sensitive env *values* from content flowing
 * back to the model. Every tool result is scrubbed, not only shell output.
 *
 * Aligns with ai-agent-node `redactExecutionServerEnv` — this is not an access
 * control (the user already knows their own secrets), but a return-path
 * containment so `printenv` / accidental dumps do not persist secrets into
 * LLM context, traces, and session storage.
 */

/** Values shorter than this are skipped (avoids clobbering trivial strings like "true"). */
export const REDACT_MIN_VALUE_LENGTH = 6;

/** Names whose values are never redacted (public locators). */
const REDACT_EXEMPT_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TERM',
  'SHELL',
  'TMPDIR',
  'PWD',
  'NODE_ENV',
  'COLORTERM',
  'TERM_PROGRAM'
]);

const SENSITIVE_EXACT = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NPM_CONFIG_AUTHTOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'RAW_AGENT_API_KEY',
  'RAW_AGENT_VL_API_KEY',
  'RAW_AGENT_ANTHROPIC_API_KEY',
  'RAW_AGENT_AUTH_TOKEN'
]);

const SENSITIVE_SUFFIX_RE =
  /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_COOKIE|_AUTHORIZATION|AUTH_TOKEN)$/i;

export type RedactionTarget = [name: string, value: string];

function looksSensitiveName(name: string): boolean {
  if (REDACT_EXEMPT_NAMES.has(name)) return false;
  if (SENSITIVE_EXACT.has(name)) return true;
  return SENSITIVE_SUFFIX_RE.test(name);
}

/**
 * Collect env entries whose values should be scrubbed from tool results.
 * Longer values are matched first so overlapping substrings redact cleanly.
 */
export function collectRedactionTargets(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options?: { minLength?: number; extraNames?: string[] }
): RedactionTarget[] {
  const minLen = options?.minLength ?? REDACT_MIN_VALUE_LENGTH;
  const extra = options?.extraNames ? new Set(options.extraNames) : undefined;
  const out: RedactionTarget[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < minLen) continue;
    if (REDACT_EXEMPT_NAMES.has(name)) continue;
    if (extra?.has(name) || looksSensitiveName(name)) {
      out.push([name, value]);
    }
  }
  out.sort((a, b) => b[1].length - a[1].length);
  return out;
}

function redactWalk(node: unknown, targets: RedactionTarget[]): unknown {
  if (typeof node === 'string') {
    let out = node;
    for (const [name, value] of targets) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((item) => redactWalk(item, targets));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = redactWalk(v, targets);
    }
    return out;
  }
  return node;
}

/**
 * Deep-walk `result` and replace any occurrence of sensitive env values with
 * `[REDACTED:<NAME>]`. Non-string leaves are left unchanged.
 */
export function redactEnvValues<T>(
  result: T,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options?: { minLength?: number; extraNames?: string[]; targets?: RedactionTarget[] }
): T {
  const targets = options?.targets ?? collectRedactionTargets(env, options);
  if (targets.length === 0) return result;
  return redactWalk(result, targets) as T;
}

/** Convenience: redact a tool content string against `process.env` (or override). */
export function redactToolContent(
  content: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return redactEnvValues(content, env);
}
