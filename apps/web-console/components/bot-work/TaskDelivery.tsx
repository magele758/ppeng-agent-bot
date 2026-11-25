'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { renderMarkdown } from '@/lib/markdown';
import { useLab } from '../shell/LabProvider';
import { api, json, useAction, Feedback, Result, Status } from './shared';
import styles from './bot-team-work.module.css';

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

const PREVIEWABLE_MIME = /^(text\/|application\/(json|xml|javascript))/;
const MAX_PREVIEW_BYTES = 256 * 1024;
const REVIEW_CHOICES = [true, false] as const;

async function readPreviewStream(
  body: ReadableStream<Uint8Array>,
  tooLargeMessage: string,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PREVIEW_BYTES) throw new Error(tooLargeMessage);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

async function fetchArtifactText(
  id: string,
  signal: AbortSignal,
  failedMessage: string,
  tooLargeMessage: string,
): Promise<string> {
  const response = await fetch(`/api/artifact/${encodeURIComponent(id)}/download`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok || !response.body) throw new Error(failedMessage);
  return readPreviewStream(response.body, tooLargeMessage);
}

function DeliveryMeta({
  delivery,
  manualReview,
}: {
  delivery: Delivery;
  manualReview?: { accepted: boolean; at: string };
}) {
  const { t } = useI18n();
  const verifyKey = manualReview?.accepted ? 'botWork.deliveryManualAcceptedHint' : 'botWork.deliveryUnverified';
  const reviewText = manualReview
    ? t(manualReview.accepted ? 'botWork.reviewAccepted' : 'botWork.reviewRejected', { time: manualReview.at })
    : t('botWork.reviewMissing');
  return (
    <>
      <div className={styles.deliveryTop}>
        <h4 className={styles.deliveryHeading}>{t('botWork.deliveryTitle')}</h4>
        <p className={styles.deliveryMeta}>
          {t('botWork.deliveryAttempt', { attempt: delivery.attempt })} · <Status value={delivery.executionStatus} />
        </p>
      </div>
      <p className={styles.deliveryNotice}>{t(verifyKey)}</p>
      <p className={styles.deliveryReviewState}>{reviewText}</p>
    </>
  );
}

function DeliveryActionRow({
  delivery,
  reportUrl,
  busy,
  onReview,
  onContinue,
  onOpenSession,
}: {
  delivery: Delivery;
  reportUrl: string;
  busy: boolean;
  onReview: (accepted: boolean) => void;
  onContinue?: () => void;
  onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const canAccept = delivery.executionStatus === 'completed';
  return (
    <div className={styles.deliveryActions}>
      {REVIEW_CHOICES.map((accepted) => (
        <button
          type="button"
          key={String(accepted)}
          className={accepted ? `${styles.pillBtn} ${styles.pillBtnPrimary}` : styles.pillBtn}
          disabled={busy || (accepted && !canAccept)}
          onClick={() => onReview(accepted)}
        >
          {t(accepted ? 'botWork.acceptDelivery' : 'botWork.rejectDelivery')}
        </button>
      ))}
      {onContinue && (
        <button type="button" className={styles.pillBtn} onClick={onContinue}>
          {t('botWork.continueVersion')}
        </button>
      )}
      <button type="button" className={styles.pillBtn} onClick={onOpenSession}>
        {t('botWork.sourceTask')}
      </button>
      {delivery.report && reportUrl && (
        <a className={styles.pillBtn} href={reportUrl} download={`${delivery.taskId}-${delivery.attempt}.md`}>
          {t('botWork.exportReport')}
        </a>
      )}
    </div>
  );
}

function ArtifactCard({
  artifact,
  busy,
  onPreview,
}: {
  artifact: Delivery['artifacts'][number];
  busy: boolean;
  onPreview: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <article className={styles.artifactRow}>
      <strong className={styles.artifactName}>{artifact.fileName}</strong>
      <a className={styles.ghostBtn} href={`/api/artifact/${encodeURIComponent(artifact.id)}/download`}>
        {t('botWork.downloadFile', { name: artifact.fileName })}
      </a>
      {PREVIEWABLE_MIME.test(artifact.mimeType) && (
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy}
          onClick={() => onPreview(artifact.id)}
        >
          {t('botWork.previewFile', { name: artifact.fileName })}
        </button>
      )}
    </article>
  );
}

function hasArtifactSection(count: number, error: string, preview: string | null): boolean {
  return count > 0 || Boolean(error) || preview !== null;
}

function DeliveryArtifacts({
  artifacts,
  busy,
  error,
  preview,
  onPreview,
}: {
  artifacts: Delivery['artifacts'];
  busy: boolean;
  error: string;
  preview: string | null;
  onPreview: (id: string) => void;
}) {
  if (!hasArtifactSection(artifacts.length, error, preview)) return null;
  return (
    <div className={styles.artifactList}>
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} busy={busy} onPreview={onPreview} />
      ))}
      {error && <p role="alert">{error}</p>}
      {preview !== null && (
        <pre data-testid="artifact-preview" className={styles.artifactPreview}>
          {preview}
        </pre>
      )}
    </div>
  );
}

function DeliveryReceipts({ receipts }: { receipts: Delivery['receipts'] }) {
  const { t } = useI18n();
  return (
    <div className={styles.receiptSection}>
      <h5 className={styles.receiptHeading}>{t('botWork.executionReceipts')}</h5>
      {!receipts.length && <p className={styles.receiptEmpty}>{t('botWork.noExecutionReceipts')}</p>}
      {receipts.map((receipt) => (
        <details key={receipt.id} className={styles.receiptItem}>
          <summary className={styles.receiptSummary}>
            {receipt.toolName} · <Status value={receipt.state} />
          </summary>
          <div className={styles.receiptBody}>
            <p className={styles.receiptMeta}>
              {receipt.connectorId} · {receipt.id}
            </p>
            <Result value={receipt.result ?? receipt.error} />
          </div>
        </details>
      ))}
    </div>
  );
}

function formatPreviewError(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

function useArtifactPreview() {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const reset = () => {
    requestRef.current?.abort();
    setPreview(null);
    setError('');
  };

  const applyIfActive = (controller: AbortController, fn: () => void) => {
    if (!controller.signal.aborted) fn();
  };

  const showPreview = async (id: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setPreview(null);
    setError('');
    try {
      const text = await fetchArtifactText(
        id,
        controller.signal,
        t('botWork.previewFailed'),
        t('botWork.previewTooLarge'),
      );
      applyIfActive(controller, () => setPreview(text));
    } catch (failure) {
      applyIfActive(controller, () => setError(formatPreviewError(failure, t('botWork.previewFailed'))));
    } finally {
      applyIfActive(controller, () => setBusy(false));
    }
  };

  return { preview, error, busy, reset, showPreview };
}

export function TaskDelivery({ delivery, onContinue }: { delivery: Delivery; onContinue?: () => void }) {
  const { t } = useI18n();
  const { openSession } = useLab();
  const reviewAction = useAction();
  const [manualReview, setManualReview] = useState(delivery.manualReview);
  const [reportUrl, setReportUrl] = useState('');
  const artifactPreview = useArtifactPreview();

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([delivery.report], { type: 'text/markdown;charset=utf-8' }));
    setReportUrl(url);
    artifactPreview.reset();
    return () => {
      URL.revokeObjectURL(url);
      artifactPreview.reset();
    };
  }, [delivery.taskId, delivery.attempt, delivery.report]);

  const submitReview = (accepted: boolean) => {
    void reviewAction.run(async () => {
      const result = (await api(
        `/api/bot-work/tasks/${encodeURIComponent(delivery.taskId)}/review`,
        json({ attempt: delivery.attempt, accepted }),
      )) as { review: { accepted: boolean; at: string } };
      setManualReview(result.review);
    });
  };

  return (
    <section className={styles.deliveryCard} data-testid="bot-task-delivery">
      <DeliveryMeta delivery={delivery} manualReview={manualReview} />
      {delivery.failureReason && (
        <p role="status" className={styles.deliveryFailure}>
          {t('botWork.unfinishedReason', { reason: delivery.failureReason })}
        </p>
      )}
      <Feedback {...reviewAction} />
      <DeliveryActionRow
        delivery={delivery}
        reportUrl={reportUrl}
        busy={reviewAction.busy}
        onReview={submitReview}
        onContinue={onContinue}
        onOpenSession={() => void openSession(delivery.sessionId, { focusChat: true })}
      />
      {delivery.report && (
        <div
          className={`markdown-body ${styles.deliveryReport}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(delivery.report) }}
        />
      )}
      <DeliveryArtifacts
        artifacts={delivery.artifacts}
        busy={artifactPreview.busy}
        error={artifactPreview.error}
        preview={artifactPreview.preview}
        onPreview={(id) => void artifactPreview.showPreview(id)}
      />
      <DeliveryReceipts receipts={delivery.receipts} />
    </section>
  );
}
