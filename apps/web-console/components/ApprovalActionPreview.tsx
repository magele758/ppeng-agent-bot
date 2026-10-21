'use client';

import { approvalPreview } from '@/lib/approval-preview';
import { useI18n } from '@/lib/i18n';

export function ApprovalActionPreview({ args }: { args?: Record<string, unknown> }) {
  const { t } = useI18n();
  const preview = approvalPreview(args);
  return <div data-testid="approval-action-preview">
    {preview.target && <p>{t('botWork.affectedTarget', { target: preview.target })}</p>}
    {preview.content && <div>
      <strong>{t('botWork.actualContent')}</strong>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.content}</pre>
    </div>}
    <details>
      <summary>{t('botWork.proposedArguments')}</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.details, null, 2)}</pre>
    </details>
  </div>;
}
