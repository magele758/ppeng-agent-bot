'use client';

import {
  autoReviewCardFace,
  autoReviewKindLabelKey,
  type AutoReviewCardInput,
  type AutoReviewCardKind
} from '@/lib/auto-review-card';
import { useI18n } from '@/lib/i18n';

/** Kind badge and block reason for an Auto-review card; other approvals keep their existing reason line. */
export function ApprovalReasonLine({
  approval,
  fallback
}: {
  approval: AutoReviewCardInput;
  fallback?: string | null;
}) {
  const face = autoReviewCardFace(approval);
  if (face) return <AutoReviewFace face={face} />;
  if (!fallback) return null;
  return <span className="muted small">{fallback}</span>;
}

export function InboxApprovalReason({ approval }: { approval: AutoReviewCardInput }) {
  const { t } = useI18n();
  const reason = approval.reason?.trim() ? approval.reason : t('tasks.inbox.noReason');
  return <ApprovalReasonLine approval={approval} fallback={t('tasks.inbox.reason', { reason })} />;
}

function AutoReviewFace({ face }: { face: { kind: AutoReviewCardKind; blockReason: string } }) {
  const { t } = useI18n();
  return (
    <span className="approval-auto-review" data-auto-review="1">
      <span className="approval-kind-badge" data-kind={face.kind}>
        {t(autoReviewKindLabelKey(face.kind))}
      </span>
      <span className="approval-block-reason">
        <span className="muted small">{t('play.approval.blockReasonLabel')}</span>{' '}
        <span data-block-reason={face.blockReason}>{face.blockReason}</span>
      </span>
    </span>
  );
}
