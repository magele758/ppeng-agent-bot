'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  contextStackLegend,
  formatContextShare,
  stackContextSegments
} from '@/lib/context-stack-bar';
import {
  buildContextReplayFrames,
  replayFrameIndex,
  selectContextReplayFrame,
  type ReplaySnapshot
} from '@/lib/context-stack-replay';
import { useI18n, type MessageKey } from '@/lib/i18n';

interface ContextStackBlock {
  id: string;
  kind: string;
  label: string;
  text: string;
  tokens: number;
  chars: number;
  pinned: boolean;
  disposition: 'keep' | 'summarize' | 'dropped';
}

interface ContextStackBudget {
  mode: 'normal' | 'canonical-bot';
  windowTokens: number;
  capTokens: number;
  requestTokens: number;
  pinnedTokens: number;
  pinnedOverBudget: boolean;
  wouldSummarize: boolean;
  wouldCompact: boolean;
  ratio: number | null;
  structuredTokens: number | null;
  hygieneTokens: number | null;
  historyTokens: number | null;
  messageTokens: number;
}

interface ContextStackPayload {
  sessionId: string;
  blocks: ContextStackBlock[];
  budget: ContextStackBudget;
}

function kindKey(kind: string): MessageKey | null {
  switch (kind) {
    case 'system':
      return 'play.contextStack.kinds.system';
    case 'system-message':
      return 'play.contextStack.kinds.systemMessage';
    case 'tools':
      return 'play.contextStack.kinds.tools';
    case 'summary':
      return 'play.contextStack.kinds.summary';
    case 'memory':
      return 'play.contextStack.kinds.memory';
    case 'working-log':
      return 'play.contextStack.kinds.workingLog';
    case 'user':
      return 'play.contextStack.kinds.user';
    case 'assistant':
      return 'play.contextStack.kinds.assistant';
    case 'reasoning':
      return 'play.contextStack.kinds.reasoning';
    case 'tool-call':
      return 'play.contextStack.kinds.toolCall';
    case 'tool-result':
      return 'play.contextStack.kinds.toolResult';
    case 'tool-stub':
      return 'play.contextStack.kinds.toolStub';
    case 'image':
      return 'play.contextStack.kinds.image';
    case 'surface':
      return 'play.contextStack.kinds.surface';
    case 'history-sources':
      return 'play.contextStack.kinds.historySources';
    default:
      return null;
  }
}

export function ContextStackPanel({
  sessionId,
  running,
  messageCount
}: {
  sessionId: string | null;
  running: boolean;
  messageCount: number;
}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ContextStackPayload | null>(null);
  const [snapshots, setSnapshots] = useState<ReplaySnapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('live');
  const request = useRef(0);

  const load = useCallback(async () => {
    const sid = sessionId;
    const ticket = ++request.current;
    if (!sid) {
      setData(null);
      setSnapshots([]);
      setErr(null);
      setReplayErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [stackResult, historyResult] = await Promise.allSettled([
        api(`/api/sessions/${encodeURIComponent(sid)}/context-stack`),
        api(`/api/sessions/${encodeURIComponent(sid)}/context-snapshots`)
      ]);
      if (request.current !== ticket) return;
      if (stackResult.status === 'rejected') {
        const reason = stackResult.reason;
        setErr(reason instanceof Error ? reason.message : String(reason));
        setData(null);
      } else {
        setData(stackResult.value as ContextStackPayload);
        setErr(null);
      }
      if (historyResult.status === 'rejected') {
        const reason = historyResult.reason;
        setSnapshots([]);
        setReplayErr(reason instanceof Error ? reason.message : String(reason));
      } else {
        const history = historyResult.value as { snapshots?: ReplaySnapshot[] };
        setSnapshots(Array.isArray(history.snapshots) ? history.snapshots : []);
        setReplayErr(null);
      }
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSelectedId('live');
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, running, messageCount]);

  const labelFor = (kind: string) => {
    const key = kindKey(kind);
    return key ? t(key) : kind;
  };

  const body = data && data.sessionId === sessionId ? data : null;
  const frames = body ? buildContextReplayFrames(snapshots, body.blocks) : [];
  const frameIndex = replayFrameIndex(frames, selectedId);
  const frame = selectContextReplayFrame(frames, frameIndex) ?? null;
  const shownBlocks = frame?.blocks ?? [];
  const stacked = frame ? stackContextSegments(shownBlocks) : null;
  const legend = stacked ? contextStackLegend(stacked.segments) : [];
  const replayTime = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };
  const positionLabel = !frame
    ? ''
    : frame.live
      ? t('play.contextStack.replayLive')
      : t('play.contextStack.replayAt', {
          turn: String(frame.turn ?? ''),
          time: frame.createdAt ? replayTime(frame.createdAt) : ''
        });
  const chooseFrame = (index: number) => {
    const next = selectContextReplayFrame(frames, index);
    if (next) setSelectedId(next.id);
  };

  return (
    <div className="context-stack">
      <div className="context-stack__head">
        <p className="context-stack__hint">
          {frame && !frame.live ? t('play.contextStack.replayHint') : t('play.contextStack.hint')}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          disabled={!sessionId || loading}
        >
          {t('play.contextStack.refresh')}
        </button>
      </div>
      {!sessionId ? <p className="empty-hint">{t('play.contextStack.pickSession')}</p> : null}
      {err ? <p className="empty-hint">{t('play.contextStack.loadFailed', { message: err })}</p> : null}
      {replayErr ? <p className="empty-hint">{t('play.contextStack.replayLoadFailed', { message: replayErr })}</p> : null}
      {sessionId && loading && !body ? <p className="empty-hint">{t('play.contextStack.loading')}</p> : null}
      {body && stacked && frame ? (
        <>
          <div className="context-stack__replay">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => chooseFrame(frameIndex - 1)}
              disabled={frameIndex <= 0}
            >
              {t('play.contextStack.replayEarlier')}
            </button>
            <input
              className="context-stack__scrub"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              step={1}
              value={frameIndex}
              disabled={frames.length <= 1}
              aria-label={t('play.contextStack.replayScrub')}
              aria-valuetext={positionLabel}
              onChange={(event) => chooseFrame(Number(event.target.value))}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => chooseFrame(frameIndex + 1)}
              disabled={frameIndex >= frames.length - 1}
            >
              {t('play.contextStack.replayLater')}
            </button>
          </div>
          <p className="context-stack__replay-label">{positionLabel}</p>
          {frame.live ? (
            <>
              <p className="context-stack__budget">
                {body.budget.mode === 'canonical-bot'
                  ? t('play.contextStack.budgetBot', {
                      messages: String(body.budget.messageTokens),
                      structured: String(body.budget.structuredTokens ?? 0),
                      hygiene: String(body.budget.hygieneTokens ?? 0),
                      history: String(body.budget.historyTokens ?? 0)
                    })
                  : t('play.contextStack.budgetNormal', {
                      request: String(body.budget.requestTokens),
                      cap: String(body.budget.capTokens),
                      window: String(body.budget.windowTokens),
                      ratio: String(Math.round((body.budget.ratio ?? 0.2) * 100))
                    })}
              </p>
              {body.budget.pinnedOverBudget ? <p className="context-stack__note">{t('play.contextStack.pinnedOver')}</p> : null}
              {body.budget.wouldSummarize ? <p className="context-stack__note">{t('play.contextStack.wouldSummarize')}</p> : null}
              {body.budget.wouldCompact ? <p className="context-stack__note">{t('play.contextStack.wouldCompact')}</p> : null}
            </>
          ) : null}
          {shownBlocks.length === 0 ? <p className="empty-hint">{t('play.contextStack.empty')}</p> : null}
          {shownBlocks.length > 0 ? (
            <div
              className="context-stack__bar"
              role="img"
              aria-label={t('play.contextStack.barAria')}
            >
              {stacked.segments.map((segment) => (
                <span
                  key={segment.id}
                  className={`context-stack__seg context-stack__seg--${segment.disposition}`}
                  style={{ flexGrow: segment.share, backgroundColor: segment.color }}
                  title={`${labelFor(segment.kind)} · ${formatContextShare(segment.share)}%`}
                />
              ))}
            </div>
          ) : null}
          {legend.length > 0 ? (
            <ul className="context-stack__legend" aria-label={t('play.contextStack.legend')}>
              {legend.map((item) => (
                <li key={item.kind}>
                  <span className="context-stack__swatch" style={{ background: item.color }} />
                  <span>{labelFor(item.kind)}</span>
                  <span className="context-stack__share">{formatContextShare(item.share)}%</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ol className="context-stack__list">
            {shownBlocks.map((item) => {
              const segment = stacked.segments.find((entry) => entry.id === item.id);
              return (
                <li key={item.id} className={`context-stack__block context-stack__block--${item.disposition}`} data-kind={item.kind}>
                  <div className="context-stack__block-head">
                    <span className="context-stack__swatch" style={{ background: segment?.color }} />
                    <span className="context-stack__kind">{labelFor(item.kind)}</span>
                    {item.label ? <span className="context-stack__label">{item.label}</span> : null}
                    {item.pinned ? <span className="context-stack__flag">{t('play.contextStack.pinned')}</span> : null}
                    {item.disposition !== 'keep' ? (
                      <span className="context-stack__flag">
                        {item.disposition === 'summarize'
                          ? t('play.contextStack.dispositionSummarize')
                          : t('play.contextStack.dispositionDropped')}
                      </span>
                    ) : null}
                    <span className="context-stack__meta">
                      {t('play.contextStack.blockMeta', {
                        tokens: String(item.tokens),
                        share: formatContextShare(segment?.share ?? 0),
                        chars: String(item.chars)
                      })}
                    </span>
                  </div>
                  <pre className="context-stack__text">{item.text}</pre>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </div>
  );
}
