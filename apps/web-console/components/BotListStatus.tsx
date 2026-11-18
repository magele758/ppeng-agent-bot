'use client';

import { useI18n } from '@/lib/i18n';
import { botListPhase, type BotListPhase } from './bot-list-phase';
import './bot-home.css';

export function BotListNotices({
  loaded,
  error,
  botCount,
  roomCount,
  groupCount,
  onRetry
}: {
  loaded: boolean;
  error: string;
  botCount: number;
  roomCount: number;
  groupCount: number;
  onRetry: () => void;
}) {
  const phase = botListPhase(loaded, error, botCount, roomCount, groupCount);
  return <BotListStatus phase={phase} detail={error} onRetry={onRetry} />;
}

function BotListStatus({ phase, detail, onRetry }: { phase: BotListPhase; detail: string; onRetry: () => void }) {
  if (phase === 'loading') return <LoadingStatus />;
  if (phase === 'empty') return <EmptyStatus />;
  return problemStatus(phase, detail, onRetry);
}

function problemStatus(phase: BotListPhase, detail: string, onRetry: () => void) {
  if (phase === 'error') return <ErrorStatus detail={detail} onRetry={onRetry} keep={false} />;
  if (phase === 'keep') return <ErrorStatus detail={detail} onRetry={onRetry} keep />;
  return null;
}

function LoadingStatus() {
  const { t } = useI18n();
  return (
    <div className="bot-list-status bot-list-status--loading" data-testid="bot-list-loading" role="status" aria-busy="true">
      <span className="sr-only">{t('play.botHome.loading')}</span>
      <span className="bot-list-skel"><i /><b /></span>
      <span className="bot-list-skel"><i /><b /></span>
      <span className="bot-list-skel"><i /><b /></span>
    </div>
  );
}

function ErrorStatus({ detail, onRetry, keep }: { detail: string; onRetry: () => void; keep: boolean }) {
  const { t } = useI18n();
  const testId = keep ? 'bot-list-kept' : 'bot-list-error';
  const className = keep ? 'bot-list-status is-kept' : 'bot-list-status bot-list-status--error';
  return (
    <div className={className} data-testid={testId} role="alert">
      <p className="bot-list-status__title">{t('play.botHome.errorTitle')}</p>
      <p className="bot-list-status__hint">{detail || t('play.botHome.errorHint')}</p>
      <button type="button" onClick={onRetry}>{t('play.botHome.retry')}</button>
    </div>
  );
}

function EmptyStatus() {
  const { t } = useI18n();
  return (
    <div className="bot-list-status bot-list-status--empty" data-testid="bot-list-empty">
      <p className="bot-list-status__title">{t('play.botHome.emptyTitle')}</p>
      <p className="bot-list-status__hint">{t('play.botHome.emptyHint')}</p>
    </div>
  );
}
