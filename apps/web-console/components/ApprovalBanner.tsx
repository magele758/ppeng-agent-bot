'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { approvalShownLines } from '@/lib/approval-feed';
import { useI18n } from '@/lib/i18n';
import type { ApprovalItem } from '@/lib/types';

function argsPreview(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args ?? '');
  }
}

export function ApprovalBanner({
  approvals,
  onDone
}: {
  approvals: ApprovalItem[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  if (!approvals.length) return null;

  return (
    <div className="approval-banner" role="region" aria-label={t('play.approval.aria')}>
      <div className="approval-banner__title">{t('play.approval.title')}</div>
      {approvals.map((a) => (
        <ApprovalItemRow key={a.id} approval={a} onDone={onDone} />
      ))}
    </div>
  );
}

function ApprovalItemRow({ approval: a, onDone }: { approval: ApprovalItem; onDone: () => void }) {
  const { t } = useI18n();
  const [reply, setReply] = useState('');
  const isAsk = a.toolName === 'ask_user';
  const shown = approvalShownLines(a, t('play.approval.needInfo'));

  const approve = async () => {
    if (isAsk) {
      if (!reply.trim() || !a.sessionId) return;
      await api(`/api/sessions/${encodeURIComponent(a.sessionId)}/ask-user/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: reply.trim() })
      });
    }
    await api(`/api/approvals/${a.id}/approve`, { method: 'POST' });
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
        <pre className="approval-banner__args">{argsPreview(a.args)}</pre>
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
          onClick={() => void approve()}
        >
          {isAsk ? t('play.approval.replyContinue') : t('play.approval.approveContinue')}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            void api(`/api/approvals/${a.id}/reject`, { method: 'POST' }).then(() => onDone())
          }
        >
          {t('play.approval.reject')}
        </button>
      </div>
    </div>
  );
}
