'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { approvalRiskKey, readApprovalExplanation, type ApprovalExplanation as Explanation } from '@/lib/approval-explanation';
import { autoReviewKindLabelKey, type AutoReviewCardInput, type AutoReviewCardKind } from '@/lib/auto-review-card';

type Props = { approval: AutoReviewCardInput; face: { kind: AutoReviewCardKind; blockReason: string } };
function useExplanation(id: string | undefined, locale: string) {
  const [result, setResult] = useState<Explanation | null>(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setResult(null);
    void api(`/api/approval-explanations/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }), signal: controller.signal
    }).then(data => {
      if (!controller.signal.aborted) setResult(readApprovalExplanation((data as { explanation?: unknown }).explanation));
    }).catch(() => {});
    return () => controller.abort();
  }, [id, locale]);
  return result;
}
export function ApprovalExplanation({ approval, face }: Props) {
  const { t, locale } = useI18n();
  const result = useExplanation(approval.id, locale);
  return <div className="approval-explanation" data-auto-review="1">
    <span className="approval-kind-badge" data-kind={face.kind}>{t(autoReviewKindLabelKey(face.kind))}</span>
    <span className="approval-explanation__section"><strong>{t('play.approval.actionHeading')}</strong>
      <span>{result?.action ?? t('play.approval.actionFallback', { tool: approval.toolName })}</span>
    </span>
    <span className="approval-explanation__section"><strong>{t('play.approval.riskHeading')}</strong>
      <span>{t(approvalRiskKey(approval))}</span>
      <ModelRisk result={result} />
    </span>
    <details className="approval-explanation__raw"><summary>{t('play.approval.originalReason')}</summary><span>{face.blockReason.split(' Prior note:')[0]}</span></details>
  </div>;
}
function ModelRisk({ result }: { result: Explanation | null }) {
  const { t } = useI18n();
  if (!result) return null;
  return <span><span>{result.risk}</span><small className="muted">{t('play.approval.modelNote')}</small></span>;
}
