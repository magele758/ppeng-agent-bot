'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { approvalShownLines } from '@/lib/approval-feed';
import {
  approvalApproveDisabled,
  approvalItemBodyKind,
  approvalPostPlan,
  approvalUsesStreamAttach
} from '@/lib/approval-item-view';
import { secureFormCardFace, type SecureFormCardFace } from '@/lib/secure-form-card';
import { attachBeforeAskUserDecision, type LiveStreamArm } from '@/lib/live-stream-attach';
import { useI18n } from '@/lib/i18n';
import type { ApprovalItem } from '@/lib/types';
import { ApprovalActionPreview } from './ApprovalActionPreview';
import { ApprovalReasonLine } from './AutoReviewMarks';

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

function ApprovalItemBody({
  kind,
  secureForm,
  question,
  args
}: {
  kind: ReturnType<typeof approvalItemBodyKind>;
  secureForm: SecureFormCardFace | null;
  question?: string;
  args?: Record<string, unknown>;
}) {
  if (kind === 'secure-form') return <p className="approval-banner__q">{secureForm!.prompt}</p>;
  if (kind === 'ask') return question ? <p className="approval-banner__q">{question}</p> : null;
  if (kind === 'preview') return <ApprovalActionPreview args={args} />;
  return null;
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
  const secureForm = secureFormCardFace(a);
  const shown = approvalShownLines(a, t('play.approval.needInfo'));
  const bodyKind = approvalItemBodyKind({
    hasSecureForm: Boolean(secureForm),
    isAsk,
    hasQuestion: Boolean(shown.question)
  });

  const postDecision = async (decision: 'approve' | 'reject') => {
    const plan = approvalPostPlan({
      decision,
      isAsk,
      reply,
      hasSession: Boolean(a.sessionId)
    });
    if (plan.type === 'noop') return;
    if (plan.type === 'ask-reply') {
      await api(`/api/sessions/${encodeURIComponent(a.sessionId!)}/ask-user/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: plan.reply })
      });
    }
    const path = decision === 'approve' ? 'approve' : 'reject';
    const send = () =>
      api(`/api/approvals/${a.id}/${path}`, { method: 'POST' }).then(() => undefined);
    const flow = approvalUsesStreamAttach({ hasAttachStream: Boolean(onAttachStream) });
    if (flow === 'direct') {
      await send();
      onDone();
      return;
    }
    await attachBeforeAskUserDecision({
      toolName: a.toolName,
      decision,
      otherPendingCount,
      sessionId: a.sessionId,
      arm: onAttachStream!,
      postDecision: send
    });
    onDone();
  };

  return (
    <div className="approval-banner__item">
      <div className="approval-banner__row">
        <strong>{a.toolName}</strong>
        <ApprovalReasonLine approval={a} fallback={shown.reason} />
      </div>
      <ApprovalItemBody
        kind={bodyKind}
        secureForm={secureForm}
        question={shown.question}
        args={a.args}
      />
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
          disabled={approvalApproveDisabled(isAsk, reply)}
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
