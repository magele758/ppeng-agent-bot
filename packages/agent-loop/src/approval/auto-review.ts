/**
 * Auto-review: product-level gate for high-risk Shell/spawn/MCP.
 *
 * Grok-aligned contract (not a UI clone):
 * 1) High-risk call without requestSmartModeApproval → default soft-block (no side effects).
 * 2) Same action + requestSmartModeApproval → native approval card (createApproval) and wait.
 * 3) Approve → same fingerprint proceeds; deny → terminal; no bypass via permissionMode=bypass.
 *
 * `authorizedBy` is an audit citation (owner message / answered-card ids), not a skip flag.
 * It is stripped from the fingerprint the same way the escalate flags are.
 */

const FLAG_KEY_SET = new Set<string>([
  'requestSmartModeApproval',
  'request_smart_mode_approval',
  'smartModeBlockReason',
  'smart_mode_block_reason',
  'authorizedBy',
  'authorized_by'
]);

export { normalizeAuthorizedBy, readAuthorizedBy } from './authorized-by.js';

const SHELL_SUBJECTS = new Set(['bash', 'bg_run', 'shell', 'work_evidence']);

const RISKY_SHELL_SUBSTRINGS = [
  'rm ',
  'git reset',
  'git checkout',
  'git clean',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'sudo ',
  'chmod 777',
  'mkfs',
  'dd if=',
  'shutdown',
  'reboot',
  'userdel',
  'passwd '
];

export type AutoReviewKind = 'shell' | 'mcp';

const AUTO_REVIEW_REMEDIATION =
  'Retry the SAME tool with the same parameters and set requestSmartModeApproval=true ' +
  '(optional smartModeBlockReason with the prior block text). Denial of the approval card is final; ' +
  'do not bypass via another tool, encoding, or permissionMode=bypass.';

type AutoReviewBlock = {
  kind: AutoReviewKind;
  /** Human-readable reason the owner sees on the approval card. */
  blockReason: string;
  reason: string;
  remediation: string;
  fingerprintInput: Record<string, unknown>;
};

export type AutoReviewDecision =
  | { action: 'allow' }
  | (AutoReviewBlock & { action: 'soft_block'; code: 'AUTO_REVIEW_BLOCKED' })
  | (AutoReviewBlock & { action: 'require_card'; code: 'AUTO_REVIEW_CARD' });

/** Shell subjects stay shell; every other Auto-review subject is MCP. */
export function autoReviewKind(toolName: string): AutoReviewKind {
  const n = toolName.trim().toLowerCase();
  if (SHELL_SUBJECTS.has(n)) return 'shell';
  return 'mcp';
}

export function isAutoReviewSubject(toolName: string): boolean {
  const n = toolName.trim().toLowerCase();
  if (SHELL_SUBJECTS.has(n)) return true;
  if (n === 'mcp_invoke' || n === 'mcp_read_resource') return true;
  if (n.startsWith('mcp_h') || n.startsWith('mcp_s')) return true;
  return false;
}

export function stripAutoReviewFlags(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (FLAG_KEY_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }
  return false;
}

export function hasRequestSmartModeApproval(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const rec = input as Record<string, unknown>;
  return truthyFlag(rec.requestSmartModeApproval) || truthyFlag(rec.request_smart_mode_approval);
}

export function readSmartModeBlockReason(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const raw = rec.smartModeBlockReason ?? rec.smart_mode_block_reason;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shellCommandOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'work_evidence') return String(input.verify_command ?? '');
  return String(input.command ?? '');
}

function isolationIsDirect(input: Record<string, unknown>): boolean {
  const raw = input.isolation;
  if (typeof raw !== 'string') return false;
  return raw.trim().toLowerCase() === 'direct';
}

function baseAutoReviewBlock(toolName: string, input: Record<string, unknown>): string {
  if (autoReviewKind(toolName) === 'mcp') {
    return 'MCP tool call can change external state and was blocked until you approve it.';
  }
  if (isolationIsDirect(input)) {
    return 'Shell isolation is direct and was blocked until you approve it.';
  }
  return 'Shell command matches a high-risk pattern and was blocked until you approve it.';
}

/** Owner-facing block text. A prior smart-mode note is kept when it adds detail. */
export function describeAutoReviewBlock(
  toolName: string,
  input: Record<string, unknown>,
  prior?: string
): string {
  const base = baseAutoReviewBlock(toolName, input);
  const note = prior?.trim() ?? '';
  if (!note || base.includes(note)) return base;
  return `${base} Prior note: ${note}`;
}

function autoReviewSummary(toolName: string, kind: AutoReviewKind, blockReason: string): string {
  return `Auto-review (${kind}) blocked high-risk ${toolName}: ${blockReason}`;
}

export function shellCommandIsHighRisk(command: string): boolean {
  const lower = command.toLowerCase();
  if (!lower.trim()) return false;
  if (RISKY_SHELL_SUBSTRINGS.some((t) => lower.includes(t))) return true;
  if (/\|\s*(?:ba)?sh\b/.test(lower)) return true;
  if (/\|\s*zsh\b/.test(lower)) return true;
  if (/<\(\s*(curl|wget)\b/.test(lower)) return true;
  return false;
}

/** MCP invoke/side-effect tools are always high-risk Auto-review subjects. */
export function isHighRiskAutoReviewCall(toolName: string, input: unknown): boolean {
  if (!isAutoReviewSubject(toolName)) return false;
  const n = toolName.trim().toLowerCase();
  const args = stripAutoReviewFlags(input);
  if (n.startsWith('mcp_') || n === 'mcp_invoke' || n === 'mcp_read_resource') {
    return true;
  }
  if (isolationIsDirect(args)) return true;
  return shellCommandIsHighRisk(shellCommandOf(n, args));
}

export function autoReviewIdempotencyKey(
  toolName: string,
  fingerprintInput: Record<string, unknown>,
  hash: (toolName: string, input: unknown) => string
): string {
  return `ar:${hash(toolName, fingerprintInput)}`;
}

/**
 * Decide Auto-review action for one tool call.
 * Callers must still consult the approval store for approved/rejected/pending.
 */
export function evaluateAutoReview(input: {
  toolName: string;
  toolInput: unknown;
}): AutoReviewDecision {
  const { toolName, toolInput } = input;
  if (!isHighRiskAutoReviewCall(toolName, toolInput)) {
    return { action: 'allow' };
  }
  return blockedAutoReview(toolName, toolInput);
}

function blockedAutoReview(toolName: string, toolInput: unknown): Exclude<AutoReviewDecision, { action: 'allow' }> {
  const fingerprintInput = stripAutoReviewFlags(toolInput);
  const kind = autoReviewKind(toolName);
  const blockReason = describeAutoReviewBlock(toolName, fingerprintInput, readSmartModeBlockReason(toolInput));
  const summary = autoReviewSummary(toolName, kind, blockReason);
  if (hasRequestSmartModeApproval(toolInput)) {
    return {
      action: 'require_card',
      code: 'AUTO_REVIEW_CARD',
      reason: summary,
      remediation: AUTO_REVIEW_REMEDIATION,
      fingerprintInput,
      blockReason,
      kind
    };
  }
  return {
    action: 'soft_block',
    code: 'AUTO_REVIEW_BLOCKED',
    reason: `${summary} Side effects were not executed.`,
    remediation: AUTO_REVIEW_REMEDIATION,
    fingerprintInput,
    blockReason,
    kind
  };
}
