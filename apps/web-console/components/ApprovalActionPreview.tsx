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
    <ApprovalCommandPreview details={preview.details} />
    <details>
      <summary>{t('botWork.proposedArguments')}</summary>
      <ApprovalArguments details={preview.details} />
    </details>
  </div>;
}

function ApprovalArguments({ details }: { details: Record<string, unknown> }) {
  const command = details.command ?? details.verify_command;
  if (typeof command !== 'string') return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(details, null, 2)}</pre>;
  const commandKey = typeof details.command === 'string' ? 'command' : 'verify_command';
  const rest = Object.fromEntries(Object.entries(details).filter(([key]) => key !== commandKey));
  return <><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{command}</pre><pre>{JSON.stringify(rest, null, 2)}</pre></>;
}

function ApprovalCommandPreview({ details }: { details: Record<string, unknown> }) {
  const { t } = useI18n();
  const command = details.command ?? details.verify_command;
  if (typeof command !== 'string') return null;
  return <div className="approval-command"><strong>{t('play.approval.commandHeading')}</strong>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '12rem', overflowY: 'auto' }}>{command}</pre>
  </div>;
}
