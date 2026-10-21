'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { renderMarkdown } from '@/lib/markdown';
import { useLab } from '../shell/LabProvider';
import { api, json, useAction, Feedback, Result, Status } from './shared';

export interface Delivery {
  taskId: string;
  sessionId: string;
  attempt: number;
  createdAt: string;
  executionStatus: string;
  report: string;
  failureReason: string | null;
  verification: 'unverified';
  manualReview?: { accepted: boolean; at: string };
  artifacts: Array<{ id: string; fileName: string; mimeType: string; totalBytes: number }>;
  receipts: Array<{ id: string; connectorId: string; toolName: string; state: string; result?: unknown; error?: string }>;
}

export function TaskDelivery({ delivery, onContinue }: { delivery: Delivery; onContinue?: () => void }) {
  const { t } = useI18n();
  const { openSession } = useLab();
  const reviewAction = useAction();
  const [manualReview, setManualReview] = useState(delivery.manualReview);
  const [reportUrl, setReportUrl] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([delivery.report], { type: 'text/markdown;charset=utf-8' }));
    setReportUrl(url);setPreview(null);setError('');
    return () => { URL.revokeObjectURL(url);previewRequest.current?.abort(); };
  }, [delivery.taskId, delivery.attempt, delivery.report]);

  const showPreview = async (id: string) => {
    previewRequest.current?.abort();
    const controller = new AbortController();previewRequest.current = controller;
    setBusy(true);setPreview(null);setError('');
    try {
      const response = await fetch(`/api/artifact/${encodeURIComponent(id)}/download`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok || !response.body) throw new Error(t('botWork.previewFailed'));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 256 * 1024) throw new Error(t('botWork.previewTooLarge'));
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      if (!controller.signal.aborted) setPreview(text);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('botWork.previewFailed'));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  return <section data-testid="bot-task-delivery">
    <h4>{t('botWork.deliveryTitle')}</h4>
    <p>{t('botWork.deliveryAttempt', { attempt: delivery.attempt })} · <Status value={delivery.executionStatus} /></p>
    <p>{t(manualReview?.accepted ? 'botWork.deliveryManualAcceptedHint' : 'botWork.deliveryUnverified')}</p>
    <p>{manualReview ? t(manualReview.accepted ? 'botWork.reviewAccepted' : 'botWork.reviewRejected', { time: manualReview.at }) : t('botWork.reviewMissing')}</p>
    <Feedback {...reviewAction} />
    {([true, false] as const).map(accepted => <button type="button" key={String(accepted)}
      disabled={reviewAction.busy || (accepted && delivery.executionStatus !== 'completed')}
      onClick={() => void reviewAction.run(async () => {
        const result = await api(`/api/bot-work/tasks/${encodeURIComponent(delivery.taskId)}/review`,
          json({ attempt: delivery.attempt, accepted })) as { review: { accepted: boolean; at: string } };
        setManualReview(result.review);
      })}>{t(accepted ? 'botWork.acceptDelivery' : 'botWork.rejectDelivery')}</button>)}
    {onContinue && <button type="button" onClick={onContinue}>{t('botWork.continueVersion')}</button>}
    <button type="button" onClick={() => void openSession(delivery.sessionId, { focusChat: true })}>{t('botWork.sourceTask')}</button>
    {delivery.report && <>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(delivery.report) }} />
      {reportUrl && <a href={reportUrl} download={`${delivery.taskId}-${delivery.attempt}.md`}>{t('botWork.exportReport')}</a>}
    </>}
    {delivery.failureReason && <p role="status">{t('botWork.unfinishedReason', { reason: delivery.failureReason })}</p>}
    {delivery.artifacts.map(artifact => <article key={artifact.id}>
      <strong>{artifact.fileName}</strong>
      <a href={`/api/artifact/${encodeURIComponent(artifact.id)}/download`}>{t('botWork.downloadFile', { name: artifact.fileName })}</a>
      {/^(text\/|application\/(json|xml|javascript))/.test(artifact.mimeType) &&
        <button type="button" disabled={busy} onClick={() => void showPreview(artifact.id)}>{t('botWork.previewFile', { name: artifact.fileName })}</button>}
    </article>)}
    {error && <p role="alert">{error}</p>}
    {preview !== null && <pre data-testid="artifact-preview" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview}</pre>}
    <h5>{t('botWork.executionReceipts')}</h5>
    {!delivery.receipts.length && <p>{t('botWork.noExecutionReceipts')}</p>}
    {delivery.receipts.map(receipt => <details key={receipt.id}>
      <summary>{receipt.toolName} · <Status value={receipt.state} /></summary>
      <p>{receipt.connectorId} · {receipt.id}</p>
      <Result value={receipt.result ?? receipt.error} />
    </details>)}
  </section>;
}
