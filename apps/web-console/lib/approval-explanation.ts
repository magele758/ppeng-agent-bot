import type { AutoReviewCardInput } from './auto-review-card';
const rules = [
  [/\brm\s/i, 'play.approval.riskDelete'],
  [/\bgit\s+(reset|checkout|clean)\b/i, 'play.approval.riskGit'],
  [/\bsudo\s|\bchmod\s+777/i, 'play.approval.riskPrivilege'],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, 'play.approval.riskPublish']
] as const;
export function approvalRiskKey(approval: AutoReviewCardInput) {
  const command = String(approval.args?.command ?? approval.args?.verify_command ?? '');
  return rules.find(([pattern]) => pattern.test(command))?.[1] ?? genericRisk(approval);
}
function genericRisk(approval: AutoReviewCardInput) {
  if (approval.toolName.startsWith('mcp_')) return 'play.approval.riskMcp';
  if (approval.args?.isolation === 'direct') return 'play.approval.riskDirect';
  return 'play.approval.riskGeneric';
}
export type ApprovalExplanation = { action: string; risk: string };
export function readApprovalExplanation(value: unknown): ApprovalExplanation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as ApprovalExplanation;
  if (typeof item.action !== 'string' || typeof item.risk !== 'string') return null;
  return { action: item.action, risk: item.risk };
}
