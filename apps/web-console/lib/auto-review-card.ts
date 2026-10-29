/** What an Auto-review approval card shows: tool kind plus the gate's block reason. */

export type AutoReviewCardKind = 'shell' | 'mcp';

const SHELL_TOOLS = new Set(['bash', 'bg_run', 'shell', 'work_evidence']);

export type AutoReviewCardInput = {
  toolName: string;
  reason?: string;
  kind?: string;
  blockReason?: string;
};

export function autoReviewKindLabelKey(
  kind: AutoReviewCardKind
): 'play.approval.kindShell' | 'play.approval.kindMcp' {
  if (kind === 'mcp') return 'play.approval.kindMcp';
  return 'play.approval.kindShell';
}

export function autoReviewCardFace(
  approval: AutoReviewCardInput
): { kind: AutoReviewCardKind; blockReason: string } | null {
  const explicit = explicitAutoReviewFace(approval);
  if (explicit) return explicit;
  return faceFromAutoReviewReason(approval);
}

function explicitAutoReviewFace(
  approval: AutoReviewCardInput
): { kind: AutoReviewCardKind; blockReason: string } | null {
  const kind = normalizeKind(approval.kind);
  const blockReason = approval.blockReason?.trim() ?? '';
  if (!kind || !blockReason) return null;
  return { kind, blockReason };
}

function normalizeKind(kind: string | undefined): AutoReviewCardKind | null {
  const value = kind?.trim().toLowerCase();
  if (value === 'shell' || value === 'mcp') return value;
  return null;
}

function faceFromAutoReviewReason(
  approval: AutoReviewCardInput
): { kind: AutoReviewCardKind; blockReason: string } | null {
  const reason = approval.reason?.trim() ?? '';
  if (!reason.includes('Auto-review')) return null;
  const kind = kindFromReasonHead(reason) ?? kindFromToolName(approval.toolName);
  if (!kind) return null;
  const blockReason = blockReasonFromReason(reason);
  if (!blockReason) return null;
  return { kind, blockReason };
}

function kindFromReasonHead(reason: string): AutoReviewCardKind | null {
  const head = reason.split(': ')[0] ?? '';
  if (head.includes('(shell)')) return 'shell';
  if (head.includes('(mcp)')) return 'mcp';
  return null;
}

function kindFromToolName(toolName: string): AutoReviewCardKind | null {
  const n = toolName.trim().toLowerCase();
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (n === 'mcp_invoke' || n === 'mcp_read_resource' || n.startsWith('mcp_')) return 'mcp';
  return null;
}

function blockReasonFromReason(reason: string): string {
  const marker = ': ';
  const idx = reason.indexOf(marker);
  if (idx < 0) return reason;
  const tail = reason.slice(idx + marker.length).trim();
  return tail || reason;
}
