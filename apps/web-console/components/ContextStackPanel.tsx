'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  contextStackLegend,
  formatContextShare,
  stackContextSegments,
  type ContextStackSegment
} from '@/lib/context-stack-bar';
import {
  buildContextReplayFrames,
  replayFrameIndex,
  selectContextReplayFrame,
  type ReplayFrame,
  type ReplaySnapshot
} from '@/lib/context-stack-replay';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { metricForTurn, toSentRequestMetrics, type SentRequestSource } from '@/lib/request-metric-turn';

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

type TFn = ReturnType<typeof useI18n>['t'];

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

function settledError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function readStack(result: PromiseSettledResult<unknown>): { data: ContextStackPayload | null; err: string | null } {
  if (result.status === 'rejected') return { data: null, err: settledError(result.reason) };
  return { data: result.value as ContextStackPayload, err: null };
}

function readSnapshots(result: PromiseSettledResult<unknown>): { snapshots: ReplaySnapshot[]; err: string | null } {
  if (result.status === 'rejected') return { snapshots: [], err: settledError(result.reason) };
  const history = result.value as { snapshots?: ReplaySnapshot[] };
  if (!Array.isArray(history.snapshots)) return { snapshots: [], err: null };
  return { snapshots: history.snapshots, err: null };
}

function matchingBody(data: ContextStackPayload | null, sessionId: string | null): ContextStackPayload | null {
  if (!data || data.sessionId !== sessionId) return null;
  return data;
}

function formatReplayTime(iso: string | null, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const tag = locale === 'zh' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function replayPositionLabel(frame: ReplayFrame, locale: string, t: TFn): string {
  if (frame.live) return t('play.contextStack.replayLive');
  return t('play.contextStack.replayAt', {
    turn: String(frame.turn ?? ''),
    time: formatReplayTime(frame.createdAt, locale)
  });
}

function frameIdAt(frames: readonly ReplayFrame[], index: number): string {
  const frame = selectContextReplayFrame(frames, index);
  if (!frame) return 'live';
  return frame.id;
}

function labelForKind(kind: string, t: TFn): string {
  const key = kindKey(kind);
  if (!key) return kind;
  return t(key);
}

function MissingSession({ sessionId, t }: { sessionId: string | null; t: TFn }) {
  if (sessionId) return null;
  return <p className="empty-hint">{t('play.contextStack.pickSession')}</p>;
}

function LoadError({ err, t }: { err: string | null; t: TFn }) {
  if (!err) return null;
  return <p className="empty-hint">{t('play.contextStack.loadFailed', { message: err })}</p>;
}

function ReplayError({ err, t }: { err: string | null; t: TFn }) {
  if (!err) return null;
  return <p className="empty-hint">{t('play.contextStack.replayLoadFailed', { message: err })}</p>;
}

function LoadingLine({ show, t }: { show: boolean; t: TFn }) {
  if (!show) return null;
  return <p className="empty-hint">{t('play.contextStack.loading')}</p>;
}

function ReplayBar({
  frames,
  index,
  frame,
  locale,
  onSelect,
  t
}: {
  frames: readonly ReplayFrame[];
  index: number;
  frame: ReplayFrame;
  locale: string;
  onSelect: (id: string) => void;
  t: TFn;
}) {
  const label = replayPositionLabel(frame, locale, t);
  return (
    <>
      <HistoryHint live={frame.live} t={t} />
      <div className="context-stack__replay">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(frameIdAt(frames, index - 1))} disabled={index <= 0}>
          {t('play.contextStack.replayEarlier')}
        </button>
        <input
          className="context-stack__scrub"
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          step={1}
          value={index}
          disabled={frames.length <= 1}
          aria-label={t('play.contextStack.replayScrub')}
          aria-valuetext={label}
          onChange={(event) => onSelect(frameIdAt(frames, Number(event.target.value)))}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onSelect(frameIdAt(frames, index + 1))}
          disabled={index >= frames.length - 1}
        >
          {t('play.contextStack.replayLater')}
        </button>
      </div>
      <p className="context-stack__replay-label">{label}</p>
    </>
  );
}

function HistoryHint({ live, t }: { live: boolean; t: TFn }) {
  if (live) return null;
  return <p className="context-stack__hint">{t('play.contextStack.replayHint')}</p>;
}

function num(value: number | null): string {
  return String(value ?? 0);
}

function BudgetLine({ budget, t }: { budget: ContextStackBudget; t: TFn }) {
  if (budget.mode === 'canonical-bot') {
    return (
      <p className="context-stack__budget">
        {t('play.contextStack.budgetBot', {
          messages: num(budget.messageTokens),
          structured: num(budget.structuredTokens),
          hygiene: num(budget.hygieneTokens),
          history: num(budget.historyTokens)
        })}
      </p>
    );
  }
  return (
    <p className="context-stack__budget">
      {t('play.contextStack.budgetNormal', {
        request: num(budget.requestTokens),
        cap: num(budget.capTokens),
        window: num(budget.windowTokens),
        ratio: String(Math.round((budget.ratio ?? 0.2) * 100))
      })}
    </p>
  );
}

function BudgetFlag({ show, text }: { show: boolean; text: string }) {
  if (!show) return null;
  return <p className="context-stack__note">{text}</p>;
}

function LiveBudget({ live, budget, t }: { live: boolean; budget: ContextStackBudget; t: TFn }) {
  if (!live) return null;
  return (
    <>
      <BudgetLine budget={budget} t={t} />
      <BudgetFlag show={budget.pinnedOverBudget} text={t('play.contextStack.pinnedOver')} />
      <BudgetFlag show={budget.wouldSummarize} text={t('play.contextStack.wouldSummarize')} />
      <BudgetFlag show={budget.wouldCompact} text={t('play.contextStack.wouldCompact')} />
    </>
  );
}

function StackBar({ segments, t }: { segments: readonly ContextStackSegment[]; t: TFn }) {
  if (segments.length === 0) return null;
  return (
    <div className="context-stack__bar" role="img" aria-label={t('play.contextStack.barAria')}>
      {segments.map((segment) => (
        <span
          key={segment.id}
          className={`context-stack__seg context-stack__seg--${segment.disposition}`}
          style={{ flexGrow: segment.share, backgroundColor: segment.color }}
          title={`${labelForKind(segment.kind, t)} · ${formatContextShare(segment.share)}%`}
        />
      ))}
    </div>
  );
}

function StackLegend({ segments, t }: { segments: readonly ContextStackSegment[]; t: TFn }) {
  const legend = contextStackLegend(segments);
  if (legend.length === 0) return null;
  return (
    <ul className="context-stack__legend" aria-label={t('play.contextStack.legend')}>
      {legend.map((item) => (
        <li key={item.kind}>
          <span className="context-stack__swatch" style={{ background: item.color }} />
          <span>{labelForKind(item.kind, t)}</span>
          <span className="context-stack__share">{formatContextShare(item.share)}%</span>
        </li>
      ))}
    </ul>
  );
}

function segmentFor(segments: readonly ContextStackSegment[], id: string): ContextStackSegment | undefined {
  return segments.find((entry) => entry.id === id);
}

function OptionalText({ text, className }: { text: string; className: string }) {
  if (!text) return null;
  return <span className={className}>{text}</span>;
}

function DispositionFlag({ disposition, t }: { disposition: ContextStackBlock['disposition']; t: TFn }) {
  if (disposition === 'keep') return null;
  const text = disposition === 'summarize'
    ? t('play.contextStack.dispositionSummarize')
    : t('play.contextStack.dispositionDropped');
  return <span className="context-stack__flag">{text}</span>;
}

function ContextBlockRow({
  item,
  segment,
  t
}: {
  item: ContextStackBlock;
  segment: ContextStackSegment | undefined;
  t: TFn;
}) {
  return (
    <li className={`context-stack__block context-stack__block--${item.disposition}`} data-kind={item.kind}>
      <div className="context-stack__block-head">
        <span className="context-stack__swatch" style={{ background: segment?.color }} />
        <span className="context-stack__kind">{labelForKind(item.kind, t)}</span>
        <OptionalText text={item.label} className="context-stack__label" />
        <OptionalText text={item.pinned ? t('play.contextStack.pinned') : ''} className="context-stack__flag" />
        <DispositionFlag disposition={item.disposition} t={t} />
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
}

function BlockList({ blocks, segments, t }: { blocks: readonly ContextStackBlock[]; segments: readonly ContextStackSegment[]; t: TFn }) {
  if (blocks.length === 0) return <p className="empty-hint">{t('play.contextStack.empty')}</p>;
  return (
    <ol className="context-stack__list">
      {blocks.map((item) => (
        <ContextBlockRow key={item.id} item={item} segment={segmentFor(segments, item.id)} t={t} />
      ))}
    </ol>
  );
}

function ContextStackBody({
  body,
  snapshots,
  selectedId,
  locale,
  onSelect,
  t
}: {
  body: ContextStackPayload;
  snapshots: readonly ReplaySnapshot[];
  selectedId: string;
  locale: string;
  onSelect: (id: string) => void;
  t: TFn;
}) {
  const frames = buildContextReplayFrames(snapshots, body.blocks);
  const index = replayFrameIndex(frames, selectedId);
  const frame = selectContextReplayFrame(frames, index);
  if (!frame) return null;
  const stacked = stackContextSegments(frame.blocks);
  return (
    <>
      <ReplayBar frames={frames} index={index} frame={frame} locale={locale} onSelect={onSelect} t={t} />
      <LiveBudget live={frame.live} budget={body.budget} t={t} />
      <StackBar segments={stacked.segments} t={t} />
      <StackLegend segments={stacked.segments} t={t} />
      <BlockList blocks={frame.blocks} segments={stacked.segments} t={t} />
    </>
  );
}

function formatSentAt(label: string | null, locale: string): { dateTime: string; text: string } | null {
  if (!label) return null;
  const date = new Date(label);
  if (Number.isNaN(date.getTime())) return { dateTime: label, text: label };
  return { dateTime: label, text: date.toLocaleTimeString(locale) };
}

function formatWindow(percent: number | null, unknown: string): string {
  if (percent == null) return unknown;
  return `${percent.toFixed(1)}%`;
}

function metricSource(
  sessionId: string | null,
  payload: SentRequestSource | null,
  latestRequest: SentRequestSource['latestRequest']
): SentRequestSource {
  if (!sessionId) return { snapshots: [], requests: [], latestRequest: null };
  const payloadSession = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const samePayload = payload && (!payloadSession || payloadSession === sessionId) ? payload : null;
  const latestSession = latestRequest && typeof latestRequest.sessionId === 'string' ? latestRequest.sessionId : '';
  const latest = latestRequest && (!latestSession || latestSession === sessionId) ? latestRequest : null;
  return {
    sessionId,
    snapshots: samePayload?.snapshots ?? [],
    requests: samePayload?.requests ?? [],
    latestRequest: latest
  };
}

function selectedTurnNumber(frames: readonly ReplayFrame[], selectedId: string): number | null {
  const frame = selectContextReplayFrame(frames, replayFrameIndex(frames, selectedId));
  if (!frame || frame.live) return null;
  return frame.turn;
}

function RequestMetricSection({
  source,
  selectedTurnNumber: turn,
  requestFailed,
  locale,
  t
}: {
  source: SentRequestSource;
  selectedTurnNumber: number | null;
  requestFailed: boolean;
  locale: string;
  t: TFn;
}) {
  const view = metricForTurn({ sent: toSentRequestMetrics(source), selectedTurnNumber: turn });
  const sentAt = view.status === 'ready' ? formatSentAt(view.metric.sentAtLabel, locale) : null;
  const title = view.status === 'ready' && !view.isLatest
    ? t('polish.requestTurnTitle', { turn: String(view.metric.turnNumber) })
    : t('polish.requestTitle');
  const headline = view.status === 'ready'
    ? t('polish.requestUnits', { count: view.metric.estimatedTokens.toLocaleString(locale) })
    : t(requestFailed ? 'polish.requestError' : 'polish.waiting');
  const windowText = formatWindow(view.status === 'ready' ? view.metric.windowPercent : null, t('polish.unknown'));
  const upstreamText = view.status === 'ready' && view.metric.upstreamInputTokens != null
    ? view.metric.upstreamInputTokens.toLocaleString(locale)
    : t('polish.unknown');
  return (
    <section className="request-metric" data-testid="latest-request-metric">
      <h4>{title}</h4>
      <strong>{headline}</strong>
      <p>{t('polish.estimate')} · {t('polish.window')}: {windowText}</p>
      <p>{t('polish.actual')}: {upstreamText}</p>
      {sentAt ? <p>{t('polish.sentAt')}: <time dateTime={sentAt.dateTime}>{sentAt.text}</time></p> : null}
    </section>
  );
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
  const [requestFailed, setRequestFailed] = useState(false);
  const [snapshotPayload, setSnapshotPayload] = useState<SentRequestSource | null>(null);
  const [latestRequest, setLatestRequest] = useState<SentRequestSource['latestRequest']>(null);
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
      setLatestRequest(null);
      setSnapshotPayload(null);
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
      const stack = readStack(stackResult);
      setData(stack.data);
      setErr(stack.err);
      setRequestFailed(historyResult.status === 'rejected');
      if (historyResult.status === 'fulfilled') {
        const value = historyResult.value as SentRequestSource;
        if (!value.sessionId || value.sessionId === sid) {
          setSnapshotPayload(value);
          setLatestRequest(value.latestRequest ?? null);
        }
      } else {
        setSnapshotPayload(null);
        setLatestRequest(null);
      }
      const history = readSnapshots(historyResult);
      setSnapshots(history.snapshots);
      setReplayErr(history.err);
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSelectedId('live');
    setSnapshotPayload(null);
    setLatestRequest(null);
    setSnapshots([]);
    setData(null);
    setErr(null);
    setReplayErr(null);
    setRequestFailed(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, running, messageCount]);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const poll = async () => {
      try {
        const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/context-snapshots?latestOnly=1`) as SentRequestSource;
        if (!alive) return;
        if (response.sessionId && response.sessionId !== sessionId) return;
        setLatestRequest(response.latestRequest ?? null);
        setRequestFailed(false);
      } catch {
        if (alive) {
          setLatestRequest(null);
          setRequestFailed(true);
        }
      }
    };
    const timer = setInterval(() => void poll(), running ? 1000 : 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [sessionId, running]);
  const body = matchingBody(data, sessionId);
  const frames = body ? buildContextReplayFrames(snapshots, body.blocks) : [];
  const source = metricSource(sessionId, snapshotPayload, latestRequest);
  const showLoading = Boolean(sessionId) && loading && !body;

  return (
    <div className="context-stack">
      <div className="context-stack__head">
        <p className="context-stack__hint">{t('play.contextStack.hint')}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={!sessionId || loading}>
          {t('play.contextStack.refresh')}
        </button>
      </div>
      {sessionId ? (
        <RequestMetricSection
          source={source}
          selectedTurnNumber={selectedTurnNumber(frames, selectedId)}
          requestFailed={requestFailed}
          locale={locale}
          t={t}
        />
      ) : null}
      <p className="empty-hint">{t(selectedId === 'live' ? 'polish.preview' : 'polish.historyNotice')}</p>
      <MissingSession sessionId={sessionId} t={t} />
      <LoadError err={err} t={t} />
      <ReplayError err={replayErr} t={t} />
      <LoadingLine show={showLoading} t={t} />
      {body ? (
        <ContextStackBody
          body={body}
          snapshots={snapshots}
          selectedId={selectedId}
          locale={locale}
          onSelect={setSelectedId}
          t={t}
        />
      ) : null}
    </div>
  );
}
