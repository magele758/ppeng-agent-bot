/**
 * Weak / strong split for identical tool-content aborts and shell browse/search caps.
 *
 * Weak:
 * - adapter name, provider kind, or model id is `heuristic` (provider id `__heuristic__`
 *   counts only when the live model id is missing or also heuristic)
 * - model id has a size token as its own segment: mini, small, haiku, flash, nano, lite
 *   (`flashlight` and `admini` do not match). Size wins over family, so gpt-4o-mini,
 *   gemini-2.5-flash, o3-mini, and claude-haiku are weak.
 *
 * Strong: everything else, including unknown or empty names (gpt-4o, gpt-4.1, gpt-5,
 * claude-opus, claude-sonnet, gemini-pro, grok, o1, o3, and names we do not recognize).
 * Unknown defaults to strong so a model the user is actually running is not cut off.
 *
 * `loop_settings.repeatGuard`: `weak` (default) | `all` | `off`.
 * Read on every tool round. No RAW_AGENT_* switch.
 * When inactive, identical tool-content aborts, repeated assistant prose, and
 * shell directory-browse / code-search caps are skipped. Same-call failure
 * streaks, GUI launch, unbounded walks, sandbox, approvals, and sensitive-path
 * refusal stay.
 */

/** Same KV key as `AGENT_LOOP_SETTINGS_KEY` in session/steer-drain.ts. */
const LOOP_SETTINGS_KEY = 'loop_settings';

export type RepeatGuardMode = 'weak' | 'all' | 'off';
export type ModelTier = 'weak' | 'strong';

export const DEFAULT_REPEAT_GUARD_MODE: RepeatGuardMode = 'weak';

export interface ModelIdentityInput {
  modelName?: string | null;
  adapterName?: string | null;
  providerId?: string | null;
  providerKind?: string | null;
}

const SIZE_TOKEN = /(?:^|[^a-z0-9])(?:mini|small|haiku|flash|nano|lite)(?:[^a-z0-9]|$)/;

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isHeuristicMarker(value: string): boolean {
  return value === 'heuristic' || value === '__heuristic__';
}

export function parseRepeatGuardMode(raw: unknown): RepeatGuardMode | undefined {
  switch (raw) {
    case 'weak':
    case 'all':
    case 'off':
      return raw;
    default:
      return undefined;
  }
}

export function resolveRepeatGuardMode(store?: {
  getDaemonControl?(key: string): unknown;
}): RepeatGuardMode {
  const saved = store?.getDaemonControl?.(LOOP_SETTINGS_KEY);
  if (!saved || typeof saved !== 'object') return DEFAULT_REPEAT_GUARD_MODE;
  return (
    parseRepeatGuardMode((saved as { repeatGuard?: unknown }).repeatGuard) ??
    DEFAULT_REPEAT_GUARD_MODE
  );
}

export function classifyModelTier(input: ModelIdentityInput): ModelTier {
  const model = norm(input.modelName);
  const adapter = norm(input.adapterName);
  const provider = norm(input.providerId);
  const kind = norm(input.providerKind);
  if (isHeuristicMarker(adapter) || isHeuristicMarker(kind) || isHeuristicMarker(model)) {
    return 'weak';
  }
  if (isHeuristicMarker(provider) && model === '') return 'weak';
  const named = model || adapter;
  if (named && SIZE_TOKEN.test(named)) return 'weak';
  return 'strong';
}

function readRef(raw: unknown): { providerId?: string; modelId?: string } {
  if (typeof raw === 'string') {
    const modelId = raw.trim();
    return modelId ? { modelId } : {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** Live adapter model id wins. Session metadata fills the id when the adapter has none. */
export function modelIdentity(input: {
  modelName?: string | null;
  adapterName?: string | null;
  metadata?: Record<string, unknown> | null;
}): ModelIdentityInput {
  const meta = input.metadata ?? undefined;
  const override = readRef(meta?.modelOverride);
  const ref = readRef(meta?.modelRef);
  const provider = meta?.provider;
  let providerKind: string | undefined;
  if (provider && typeof provider === 'object') {
    const kind = (provider as { kind?: unknown }).kind;
    if (typeof kind === 'string') providerKind = kind;
  }
  const explicit = (input.modelName ?? '').trim();
  return {
    modelName: explicit || override.modelId || ref.modelId,
    adapterName: input.adapterName,
    providerId: override.providerId || ref.providerId,
    providerKind,
  };
}

export function repeatLimitsActive(mode: RepeatGuardMode, tier: ModelTier): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'all':
      return true;
    case 'weak':
      return tier === 'weak';
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

/** User-visible marker. Kernels map this abort to stop reason `repeat_detection`. */
export function isContentRepeatAbort(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('repeat detection:');
}


export function loopGuardStopReason(reason: string | undefined): 'repeat_detection' | 'tool_loop' {
  return isContentRepeatAbort(reason) ? 'repeat_detection' : 'tool_loop';
}

/**
 * Drop identical tool-content and assistant-prose aborts when the saved mode
 * does not apply to this model. Same-call failure streaks are unchanged.
 * The guard still counts the streak, so flipping the mode takes effect on the
 * next tool round.
 */
export function applyRepeatGuard(input: {
  store?: { getDaemonControl?(key: string): unknown };
  identity: ModelIdentityInput;
  decision: { abort: true; reason: string } | { abort: false; reason?: string };
}): { abort: true; reason: string } | { abort: false; reason?: string } {
  if (!input.decision.abort) return input.decision;
  const assistantRepeat = typeof input.decision.reason === 'string' && input.decision.reason.startsWith('repeated model output');
  if (!isContentRepeatAbort(input.decision.reason) && !assistantRepeat) {
    return input.decision;
  }
  const active = repeatLimitsActive(
    resolveRepeatGuardMode(input.store),
    classifyModelTier(input.identity)
  );
  if (active) return input.decision;
  return { abort: false };
}
