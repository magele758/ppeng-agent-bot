/** Whether Lab should subscribe to the live session stream for this ask_user decision. */
export function shouldAttachLiveStreamAfterAskUser(input: {
  toolName: string;
  decision: 'approve' | 'reject';
  otherPendingCount: number;
}): boolean {
  if (input.toolName !== 'ask_user') return false;
  if (input.decision === 'approve') return true;
  return input.otherPendingCount <= 0;
}

export function liveSessionFollowRequest(sessionId: string): {
  url: string;
  body: { follow: true };
} {
  return {
    url: `/api/sessions/${encodeURIComponent(sessionId)}/stream`,
    body: { follow: true }
  };
}

export interface LiveStreamArm {
  ready: Promise<void>;
  cancel: () => void;
}

/**
 * Arm the live stream before the approval request starts the resumed run.
 * The decision is posted only after the follower is listening, so tokens are not missed.
 */
export async function attachBeforeAskUserDecision(input: {
  toolName: string;
  decision: 'approve' | 'reject';
  otherPendingCount: number;
  sessionId: string | undefined;
  arm: (sessionId: string) => LiveStreamArm;
  postDecision: () => Promise<void>;
}): Promise<'attached' | 'skipped'> {
  const attach = shouldAttachLiveStreamAfterAskUser({
    toolName: input.toolName,
    decision: input.decision,
    otherPendingCount: input.otherPendingCount
  });
  if (!attach || !input.sessionId) {
    await input.postDecision();
    return 'skipped';
  }
  const armed = input.arm(input.sessionId);
  try {
    await armed.ready;
    await input.postDecision();
    return 'attached';
  } catch (error) {
    armed.cancel();
    throw error;
  }
}
