'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  liveLines,
  outputChars,
  pushSample,
  showLiveDots,
  snapshotLive,
  type LiveLabels,
  type LiveSample,
  type LiveSegment,
  type StreamLiveSnapshot
} from '@/lib/stream-live-status';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function ensureStart(startedAtMs: { current: number }, now: number): void {
  if (startedAtMs.current !== 0) return;
  startedAtMs.current = now;
}

function useStreamLive(segments: readonly LiveSegment[]): StreamLiveSnapshot {
  const startedAtMs = useRef(0);
  const samples = useRef<LiveSample[]>([]);
  const [nowMs, setNowMs] = useState(0);
  ensureStart(startedAtMs, Date.now());
  samples.current = pushSample(samples.current, outputChars(segments), Date.now());
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = globalThis.setInterval(tick, 400);
    return () => globalThis.clearInterval(id);
  }, []);
  return snapshotLive({
    segments,
    startedAtMs: startedAtMs.current,
    nowMs: nowMs || Date.now(),
    samples: samples.current
  });
}

function liveLabels(t: Translate): LiveLabels {
  return {
    phase: {
      waiting: t('play.live.waiting'),
      thinking: t('play.live.thinking'),
      writing: t('play.live.writing'),
      card: t('play.live.card')
    },
    tool: (name) => t('play.live.tool', { name }),
    speed: (rate) => t('play.live.speed', { rate }),
    speedNone: t('play.live.speedNone'),
    chars: (count) => t('play.live.chars', { count })
  };
}

function LiveDots() {
  return (
    <span className="stream-live__dots" aria-hidden="true">
      <span className="stream-live__dot">.</span>
      <span className="stream-live__dot">.</span>
      <span className="stream-live__dot">.</span>
    </span>
  );
}

function ToolDetail({ label, name }: { label: string; name: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{name}</dd>
    </>
  );
}

export function StreamLiveStatus({
  segments,
  visibleCount,
  hiddenCount
}: {
  segments: readonly LiveSegment[];
  visibleCount: number;
  hiddenCount: number;
}) {
  const { t } = useI18n();
  const lines = liveLines(useStreamLive(segments), showLiveDots(visibleCount, hiddenCount), liveLabels(t));
  return (
    <details className="stream-live" data-phase={lines.phaseKey}>
      <summary className="stream-live__summary" title={t('play.live.summary')}>
        {lines.showDots ? <LiveDots /> : null}
        <span className="stream-live__phase">{lines.phase}</span>
        <span className="stream-live__sep" aria-hidden="true">·</span>
        <span className="stream-live__pace">{lines.pace}</span>
      </summary>
      <dl className="stream-live__detail">
        <dt>{t('play.live.elapsedLabel')}</dt>
        <dd>{lines.elapsed}</dd>
        <dt>{t('play.live.speedLabel')}</dt>
        <dd>{lines.speed}</dd>
        <dt>{t('play.live.charsLabel')}</dt>
        <dd>{lines.chars}</dd>
        {lines.showTool ? <ToolDetail label={t('play.live.doingLabel')} name={lines.toolName} /> : null}
      </dl>
    </details>
  );
}
