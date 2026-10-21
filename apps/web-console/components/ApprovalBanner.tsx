'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { approvalShownLines } from '@/lib/approval-feed';
import { attachBeforeAskUserDecision, type LiveStreamArm } from '@/lib/live-stream-attach';
import { useI18n } from '@/lib/i18n';
import type { ApprovalItem } from '@/lib/types';
import { ApprovalActionPreview } from './ApprovalActionPreview';

export function ApprovalBanner({
  approvals,
  onDone,
  onAttachStream
}: {
  approvals: ApprovalItem[];
  onDone: () => void;
  onAttachStream?: (sessionId: string) => LiveStreamArm;
}) {
  const { t } = useI18n();
  if (!approvals.length) return null;

  return (
    <div className="approval-banner" role="region" aria-label={t('play.approval.aria')}>
      <div className="approval-banner__title">{t('play.approval.title')}</div>
      {approvals.map((a) => (
        <ApprovalItemRow
          key={a.id}
          approval={a}
          otherPendingCount={approvals.filter((item) => item.id !== a.id && item.sessionId === a.sessionId).length}
          onDone={onDone}
          onAttachStream={onAttachStream}
        />
      ))}
    </div>
  );
}

function ApprovalItemRow({
  approval: a,
  otherPendingCount,
  onDone,
  onAttachStream
}: {
  approval: ApprovalItem;
  otherPendingCount: number;
  onDone: () => void;
  onAttachStream?: (sessionId: string) => LiveStreamArm;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState('');
  const isAsk = a.toolName === 'ask_user';
  const shown = approvalShownLines(a, t('play.approval.needInfo'));

  const postDecision = async (decision: 'approve' | 'reject') => {
    if (decision === 'approve' && isAsk) {
      if (!reply.trim() || !a.sessionId) return;
      await api(`/api/sessions/${encodeURIComponent(a.sessionId)}/ask-user/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: reply.trim() })
      });
    }
    const path = decision === 'approve' ? 'approve' : 'reject';
    const send = () =>
      api(`/api/approvals/${a.id}/${path}`, { method: 'POST' }).then(() => undefined);
    if (!onAttachStream) {
      await send();
      onDone();
      return;
    }
    await attachBeforeAskUserDecision({
      toolName: a.toolName,
      decision,
      otherPendingCount,
      sessionId: a.sessionId,
      arm: onAttachStream,
      postDecision: send
    });
    onDone();
  };

  return (
    <div className="approval-banner__item">
      <div className="approval-banner__row">
        <strong>{a.toolName}</strong>
        {shown.reason ? <span className="muted small">{shown.reason}</span> : null}
      </div>
      {isAsk ? (
        shown.question ? <p className="approval-banner__q">{shown.question}</p> : null
      ) : (
        <ApprovalActionPreview args={a.args} />
      )}
      {isAsk ? (
        <textarea
          className="ask-user-reply"
          rows={2}
          placeholder={t('play.approval.replyPlaceholder')}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
      ) : null}
      <div className="approval-banner__actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={isAsk && !reply.trim()}
          onClick={() => void postDecision('approve').catch(() => undefined)}
        >
          {isAsk ? t('play.approval.replyContinue') : t('play.approval.approveContinue')}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void postDecision('reject').catch(() => undefined)}
        >
          {t('play.approval.reject')}
        </button>
      </div>
    </div>
  );
}
