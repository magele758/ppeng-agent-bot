const APPROVAL_CONTINUE = /^Approval for \S+ was (?:approved|rejected|denied)\. Continue\.$/;

/** Synthetic user message the runtime appends after an approval so the agent resumes. */
export function isApprovalContinueMessage(role: string, text: string): boolean {
  return role === 'user' && APPROVAL_CONTINUE.test(text.trim());
}
