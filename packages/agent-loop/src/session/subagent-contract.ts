/**
 * Subagent spawn contract: optional tool/model whitelist, summary-only return,
 * optional confidence gate for review/evaluator roles.
 */

export interface SubagentSpawnArgs {
  prompt: string;
  role?: string;
  /** Restrict child agent tools to this allowlist (intersected with child's available tools). */
  allowedTools?: string[];
  /** Soft hint stored in session metadata for adapters that support model override. */
  model?: string;
  /**
   * When set (0–100), review/evaluator roles must include a confidence line;
   * if parsed confidence is below threshold, mark summary as low-confidence.
   */
  minConfidence?: number;
  /** Max characters of returned summary (default 4000). */
  summaryMaxChars?: number;
  /** Internal cancellation signal used by PTC; not exposed in tool JSON. */
  signal?: AbortSignal;
  /** When set, only matching scratch keys are copied to the child session. */
  scratchKeyFilter?: (key: string) => boolean;
}

export interface SubagentSummary {
  text: string;
  confidence?: number;
  lowConfidence: boolean;
  sessionId: string;
  role?: string;
  /** Set when `text` was cut to `summaryMaxChars`. Does not change success. */
  truncated?: boolean;
}

const CONFIDENCE_RE =
  /(?:confidence|置信度)\s*[:=：]?\s*(\d{1,3})\s*%?/i;

export function parseConfidenceFromText(text: string): number | undefined {
  const m = text.match(CONFIDENCE_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

export function formatSubagentSummary(input: {
  text: string;
  sessionId: string;
  role?: string;
  minConfidence?: number;
  summaryMaxChars?: number;
}): SubagentSummary {
  const max = input.summaryMaxChars && input.summaryMaxChars > 0 ? input.summaryMaxChars : 4000;
  let text = (input.text || '(subagent returned no text)').trim();
  let truncated = false;
  if (text.length > max) {
    text = `${text.slice(0, max)}\n…[truncated]`;
    truncated = true;
  }
  const confidence = parseConfidenceFromText(text);
  const needsGate =
    input.minConfidence != null &&
    input.minConfidence > 0 &&
    (input.role === 'review' ||
      input.role === 'evaluator' ||
      input.role === 'reviewer');
  const lowConfidence =
    needsGate && (confidence === undefined || confidence < (input.minConfidence as number));

  if (lowConfidence) {
    text = `[low-confidence: expected >= ${input.minConfidence}, got ${confidence ?? 'n/a'}]\n${text}`;
  }

  return {
    text,
    confidence,
    lowConfidence: Boolean(lowConfidence),
    sessionId: input.sessionId,
    role: input.role,
    ...(truncated ? { truncated: true } : {})
  };
}

export function resolveSubagentAgentId(role: string | undefined, parentAgentId: string): string {
  const normalized = role?.toLowerCase();
  if (
    normalized === 'researcher' ||
    normalized === 'implementer' ||
    normalized === 'reviewer' ||
    normalized === 'planner' ||
    normalized === 'generator' ||
    normalized === 'evaluator'
  ) {
    return normalized;
  }
  if (normalized === 'review') return 'reviewer';
  if (normalized === 'evaluator') return 'evaluator';
  if (normalized === 'research') return 'researcher';
  if (normalized === 'implement') return 'implementer';
  if (normalized === 'generator') return 'generator';
  if (normalized === 'planner') return 'planner';
  return parentAgentId;
}
