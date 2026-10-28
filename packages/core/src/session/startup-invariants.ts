/**
 * Startup invariants for compact policy, the stable system prefix, and repeatGuard.
 *
 * Pure checks: no `.js` imports from compact-settings / agent-loop, so unit tests
 * can load this file directly. Runtime passes `normalizeCompactSettings` in.
 * Persisted Lab settings win. Invalid values are repaired and logged. An empty
 * stable prefix throws. No new RAW_AGENT_* switch.
 */

import { createHash } from 'node:crypto';

/** Same KV key as compact-settings.ts. Duplicated so this file stays free of that import. */
export const COMPACT_SETTINGS_KEY = 'compact_settings';

/**
 * Same three values as `parseRepeatGuardMode` in
 * packages/agent-loop/src/recovery/repeat-guard.ts and
 * apps/daemon/src/loop-settings.ts. Missing or unknown stays `weak`.
 */
export type StartupRepeatGuardMode = 'weak' | 'all' | 'off';

const DEFAULT_REPEAT_GUARD_MODE: StartupRepeatGuardMode = 'weak';

/** Same KV key `resolveRepeatGuardMode` and Lab loop settings share. */
const LOOP_SETTINGS_KEY = 'loop_settings';

const COMPACT_POLICIES = ['keep_recent', 'after_any_assistant', 'after_text_assistant'] as const;

export type StartupCompactPolicy = (typeof COMPACT_POLICIES)[number];

export interface StartupCompactSettings {
  policy: StartupCompactPolicy;
  keepRecent: number;
  enabled?: boolean;
  updatedAt: string;
}

export interface StartupInvariantStore {
  getDaemonControl(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

export interface StartupInvariantLog {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
}

export interface StablePrefixIdentity {
  /** Agent display name. Required; blank fails closed. */
  agentName: string;
  /** Agent role. Required; blank fails closed. */
  agentRole: string;
  /** Repository root. Required; blank fails closed. */
  repoRoot: string;
}

export interface CompactInvariant {
  policy: StartupCompactPolicy;
  keepRecent: number;
  /** `ui` when Lab has saved compact settings; otherwise the built-in default. */
  source: 'ui' | 'default';
  /** True when a persisted blob was not already a valid effective policy. */
  repaired: boolean;
}

export interface RepeatGuardInvariant {
  mode: StartupRepeatGuardMode;
  /** True when a persisted loop_settings blob carried an invalid repeatGuard. */
  repaired: boolean;
}

export interface StablePrefixInvariant {
  /** Non-empty identity + repo segment asserted at startup. */
  segment: string;
  /** SHA-256 of the segment, first 16 hex chars — same width as turn_start. */
  hash: string;
}

export interface StartupInvariants {
  compact: CompactInvariant;
  repeatGuard: RepeatGuardInvariant;
  stablePrefix: StablePrefixInvariant;
}

export class StartupInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupInvariantError';
  }
}

export function parseStartupRepeatGuardMode(raw: unknown): StartupRepeatGuardMode | undefined {
  switch (raw) {
    case 'weak':
    case 'all':
    case 'off':
      return raw;
    default:
      return undefined;
  }
}

function persistedRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function isCompactPolicy(raw: unknown): raw is StartupCompactPolicy {
  return typeof raw === 'string' && (COMPACT_POLICIES as readonly string[]).includes(raw);
}

/**
 * Effective compact policy for this process.
 * A saved Lab blob wins over the built-in default. A blob that does not
 * already match `normalize` is rewritten and logged.
 */
export function assertCompactInvariant(
  store: StartupInvariantStore,
  normalize: (raw: unknown) => StartupCompactSettings,
  log?: StartupInvariantLog
): CompactInvariant {
  const raw = store.getDaemonControl(COMPACT_SETTINGS_KEY);
  const persisted = raw != null;
  const saved = persisted ? persistedRecord(raw) : undefined;
  const normalized = normalize(saved);
  if (!isCompactPolicy(normalized.policy) || typeof normalized.keepRecent !== 'number') {
    throw new StartupInvariantError('compact settings resolved to an empty policy');
  }
  const policyValid = saved !== undefined && saved.policy === normalized.policy;
  const keepValid = saved !== undefined && saved.keepRecent === normalized.keepRecent;
  const repaired = persisted && (!saved || !policyValid || !keepValid);
  if (repaired) {
    log?.warn('startup invariant: compact settings repaired', {
      policy: saved?.policy,
      keepRecent: saved?.keepRecent,
      repairedPolicy: normalized.policy,
      repairedKeepRecent: normalized.keepRecent
    });
    if (typeof store.setDaemonControl === 'function') {
      store.setDaemonControl(COMPACT_SETTINGS_KEY, normalized);
    } else {
      log?.warn(
        'startup invariant: compact settings could not be persisted; using repaired value in memory'
      );
    }
  }
  return {
    policy: normalized.policy,
    keepRecent: normalized.keepRecent,
    source: persisted ? 'ui' : 'default',
    repaired
  };
}

/**
 * repeatGuard for the first tool round.
 * Missing loop settings stay at the default (`weak`). A saved object with an
 * invalid mode is rewritten to `weak` and logged. `weak` | `all` | `off` pass through.
 */
export function assertRepeatGuardInvariant(
  store: StartupInvariantStore,
  log?: StartupInvariantLog
): RepeatGuardInvariant {
  const saved = persistedRecord(store.getDaemonControl(LOOP_SETTINGS_KEY));
  if (!saved) {
    return { mode: DEFAULT_REPEAT_GUARD_MODE, repaired: false };
  }
  const parsed = parseStartupRepeatGuardMode(saved.repeatGuard);
  if (parsed) return { mode: parsed, repaired: false };
  const repaired: StartupRepeatGuardMode = DEFAULT_REPEAT_GUARD_MODE;
  log?.warn('startup invariant: repeatGuard repaired', {
    repeatGuard: saved.repeatGuard,
    repaired
  });
  if (typeof store.setDaemonControl === 'function') {
    store.setDaemonControl(LOOP_SETTINGS_KEY, { ...saved, repeatGuard: repaired });
  } else {
    log?.warn(
      'startup invariant: repeatGuard could not be persisted; using repaired value in memory'
    );
  }
  return { mode: repaired, repaired: true };
}

/**
 * Identity + repo segment of the stable system prefix.
 * Matches the identity and repo lines `PromptBuilder.buildStablePrefix` always
 * emits. Blank identity fails closed — an empty prefix must not be hashed or sent.
 */
export function stablePrefixIdentitySegment(identity: StablePrefixIdentity): string {
  const agentName = identity.agentName.trim();
  const agentRole = identity.agentRole.trim();
  const repoRoot = identity.repoRoot.trim();
  if (!agentName || !agentRole || !repoRoot) {
    throw new StartupInvariantError(
      'stable prefix is empty: agent name, role, and repository root are required'
    );
  }
  return `You are ${agentName} (${agentRole}).\n\nRepository root: ${repoRoot}`;
}

/** SHA-256 hex, first 16 chars. Same truncation turn_start diagnostics use. */
export function stablePrefixHashOf(segment: string): string {
  if (!segment.trim()) {
    throw new StartupInvariantError('stable prefix hash requires a non-empty segment');
  }
  return createHash('sha256').update(segment).digest('hex').slice(0, 16);
}

/**
 * Hash the stable prefix the same way turn_start does: SHA-256 of
 * `buildStablePrefix`, first 16 hex chars. Startup uses the identity+repo
 * segment; a turn passes the full prefix so the diagnostic matches the prompt.
 */
export function hashStablePrefix(prefix: string): string {
  return stablePrefixHashOf(prefix);
}

export function assertStablePrefixInvariant(identity: StablePrefixIdentity): StablePrefixInvariant {
  const segment = stablePrefixIdentitySegment(identity);
  return { segment, hash: stablePrefixHashOf(segment) };
}

/**
 * Run all three checks. Compact and repeatGuard repair in place.
 * An empty stable prefix throws `StartupInvariantError` (fail closed).
 */
export function assertStartupInvariants(input: {
  store: StartupInvariantStore;
  normalizeCompact: (raw: unknown) => StartupCompactSettings;
  identity: StablePrefixIdentity;
  log?: StartupInvariantLog;
}): StartupInvariants {
  const compact = assertCompactInvariant(input.store, input.normalizeCompact, input.log);
  const repeatGuard = assertRepeatGuardInvariant(input.store, input.log);
  const stablePrefix = assertStablePrefixInvariant(input.identity);
  input.log?.info('startup invariants ok', {
    compactPolicy: compact.policy,
    compactKeepRecent: compact.keepRecent,
    compactSource: compact.source,
    compactRepaired: compact.repaired,
    repeatGuard: repeatGuard.mode,
    repeatGuardRepaired: repeatGuard.repaired,
    stablePrefixHash: stablePrefix.hash
  });
  return { compact, repeatGuard, stablePrefix };
}
