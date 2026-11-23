/**
 * Tool-result redaction: strip sensitive env *values* from content flowing
 * back to the model. Every tool result is scrubbed, not only shell output.
 *
 * Aligns with ai-agent-node `redactExecutionServerEnv` — this is not an access
 * control (the user already knows their own secrets), but a return-path
 * containment so `printenv` / accidental dumps do not persist secrets into
 * LLM context, traces, and session storage.
 */

import { currentSecretOverrides, getBoundSecretVault } from '../secrets/secret-vault.js';

/** Values shorter than this are skipped (avoids clobbering trivial strings like "true"). */
export const REDACT_MIN_VALUE_LENGTH = 6;

/** Minimum secret length before expanding encoded variants (URL, JSON, Base64). */
export const REDACT_ENCODING_MIN_VALUE_LENGTH = 8;

const REDACTION_ENV_BRAND = Symbol('redactionEnvBrand');
const VAULT_SECRET_NAMES = Symbol('redactionVaultSecretNames');

type TaggedRedactionEnv = Record<string, string | undefined> & {
  [REDACTION_ENV_BRAND]?: true;
  [VAULT_SECRET_NAMES]?: ReadonlySet<string>;
};

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
 * Merge `baseEnv` with active `SecretVault` entries and `AsyncLocalStorage`
 * secret overrides so return-path redaction covers injected and vaulted secrets.
 */
export function buildRedactionEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const vaultValues = getBoundSecretVault()?.snapshotValues() ?? {};
  const alsValues = currentSecretOverrides();
  const prevVaultNames = (baseEnv as TaggedRedactionEnv)[VAULT_SECRET_NAMES];
  const merged: TaggedRedactionEnv = {
    ...baseEnv,
    ...vaultValues,
    ...alsValues
  };
  const vaultNames = new Set<string>(prevVaultNames ?? []);
  for (const name of Object.keys(vaultValues)) vaultNames.add(name);
  for (const name of Object.keys(alsValues)) vaultNames.add(name);
  Object.defineProperty(merged, REDACTION_ENV_BRAND, {
    value: true,
    enumerable: false
  });
  if (vaultNames.size > 0) {
    Object.defineProperty(merged, VAULT_SECRET_NAMES, {
      value: vaultNames,
      enumerable: false
    });
  }
  return merged;
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
  const vaultNames = (env as TaggedRedactionEnv)[VAULT_SECRET_NAMES];
  const out: RedactionTarget[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < minLen) continue;
    if (REDACT_EXEMPT_NAMES.has(name)) continue;
    if (extra?.has(name) || vaultNames?.has(name) || looksSensitiveName(name)) {
      out.push([name, value]);
    }
  }
  out.sort((a, b) => b[1].length - a[1].length);
  return out;
}

interface CompiledRedactionPattern {
  form: string;
  replacement: string;
}

/**
 * Expand a secret value into raw + encoded forms (URL upper/lower `%XX`,
 * JSON-escaped, standard/URL-safe Base64) when `value.length >= REDACT_ENCODING_MIN_VALUE_LENGTH`.
 */
function expandSecretForms(value: string): string[] {
  const forms = new Set<string>([value]);
  if (value.length >= REDACT_ENCODING_MIN_VALUE_LENGTH) {
    const urlUpper = encodeURIComponent(value);
    if (urlUpper !== value) {
      forms.add(urlUpper);
      forms.add(urlUpper.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    }
    if (/[!'()*]/.test(value)) {
      const rfc3986Upper = urlUpper.replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
      );
      forms.add(rfc3986Upper);
      forms.add(rfc3986Upper.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    }

    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      forms.add(jsonEscaped);
      const jsonDouble = JSON.stringify(jsonEscaped).slice(1, -1);
      if (jsonDouble !== jsonEscaped) forms.add(jsonDouble);
    }

    const buf = Buffer.from(value, 'utf8');
    const b64Std = buf.toString('base64');
    forms.add(b64Std);
    if (b64Std.endsWith('=')) {
      forms.add(b64Std.replace(/=+$/, ''));
    }
    const b64Url = buf.toString('base64url');
    forms.add(b64Url);
    const b64UrlPadded = b64Std.replace(/\+/g, '-').replace(/\//g, '_');
    forms.add(b64UrlPadded);
  }
  return [...forms];
}

function compileRedactionPatterns(targets: RedactionTarget[]): CompiledRedactionPattern[] {
  const seen = new Set<string>();
  const patterns: CompiledRedactionPattern[] = [];
  for (const [name, value] of targets) {
    const replacement = `[REDACTED:${name}]`;
    for (const form of expandSecretForms(value)) {
      if (!form || seen.has(form)) continue;
      seen.add(form);
      patterns.push({ form, replacement });
    }
  }
  patterns.sort((a, b) => b.form.length - a.form.length);
  return patterns;
}

function redactWalk(node: unknown, patterns: CompiledRedactionPattern[]): unknown {
  if (typeof node === 'string') {
    let out = node;
    for (const { form, replacement } of patterns) {
      if (out.includes(form)) out = out.split(form).join(replacement);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((item) => redactWalk(item, patterns));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = redactWalk(v, patterns);
    }
    return out;
  }
  return node;
}

/**
 * Deep-walk `result` and replace any occurrence of sensitive env values
 * (raw and encoded variants for length >= 8) with `[REDACTED:<NAME>]`.
 * Non-string leaves are left unchanged.
 */
export function redactEnvValues<T>(
  result: T,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options?: { minLength?: number; extraNames?: string[]; targets?: RedactionTarget[] }
): T {
  const targets = options?.targets ?? collectRedactionTargets(env, options);
  if (targets.length === 0) return result;
  const patterns = compileRedactionPatterns(targets);
  return redactWalk(result, patterns) as T;
}

/**
 * Convenience: redact a tool content string against `process.env` (or override),
 * always including active `SecretVault` entries and ALS secret overrides.
 */
export function redactToolContent(
  content: string,
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
): string {
  const effectiveEnv =
    env === undefined
      ? buildRedactionEnv(process.env)
      : (env as TaggedRedactionEnv)[REDACTION_ENV_BRAND]
        ? env
        : buildRedactionEnv(env);
  return redactEnvValues(content, effectiveEnv);
}
