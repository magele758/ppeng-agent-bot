/**
 * Auto-review: product-level gate for high-risk Shell/spawn/MCP.
 *
 * Grok-aligned contract (not a UI clone):
 * 1) High-risk call without requestSmartModeApproval → default soft-block (no side effects).
 * 2) Same action + requestSmartModeApproval → native approval card (createApproval) and wait.
 * 3) Approve → same fingerprint proceeds; deny → terminal; no bypass via permissionMode=bypass.
 */

const FLAG_KEY_SET = new Set<string>([
  'requestSmartModeApproval',
  'request_smart_mode_approval',
  'smartModeBlockReason',
  'smart_mode_block_reason'
]);

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

export type AutoReviewDecision =
  | { action: 'allow' }
  | {
      action: 'soft_block';
      code: 'AUTO_REVIEW_BLOCKED';
      reason: string;
      remediation: string;
      fingerprintInput: Record<string, unknown>;
    }
  | {
      action: 'require_card';
      code: 'AUTO_REVIEW_CARD';
      reason: string;
      remediation: string;
      fingerprintInput: Record<string, unknown>;
      blockReason?: string;
    };

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
  const fingerprintInput = stripAutoReviewFlags(toolInput);
  const prior = readSmartModeBlockReason(toolInput);
  const reasonBase = `Auto-review blocked high-risk ${toolName}`;
  const remediation =
    'Retry the SAME tool with the same parameters and set requestSmartModeApproval=true ' +
    '(optional smartModeBlockReason with the prior block text). Denial of the approval card is final; ' +
    'do not bypass via another tool, encoding, or permissionMode=bypass.';

  if (hasRequestSmartModeApproval(toolInput)) {
    return {
      action: 'require_card',
      code: 'AUTO_REVIEW_CARD',
      reason: prior ? `${reasonBase}: ${prior}` : `${reasonBase} (smart-mode approval requested)`,
      remediation,
      fingerprintInput,
      blockReason: prior
    };
  }

  return {
    action: 'soft_block',
    code: 'AUTO_REVIEW_BLOCKED',
    reason: `${reasonBase}. Side effects were not executed.`,
    remediation,
    fingerprintInput
  };
}
