'use client';

import { useEffect, useId, useRef } from 'react';
import {
  botFaceColor,
  botFaceIndex,
  createBlinkClock,
  damp,
  ellipsisScale,
  expressionForMood,
  nextIdleLook,
  resolveEyePose,
  speakingMouth,
  stepBlinkClock,
  toolScan,
  type BotFaceColor,
  type LivingFaceMood
} from '@/lib/bot-face';
import './bot-face.css';

export interface BotFaceProps {
  name?: string | null;
  /** Spoken name. Omit on controls that already announce the bot name. */
  label?: string;
  testId?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Conversation mood. Cards and the empty state stay idle. */
  mood?: LivingFaceMood;
}

type Paint = { top: string; body: string; ink: string; edge: string };

const PAINT: Record<BotFaceColor | 'empty', Paint> = {
  blue: { top: '#5B93F5', body: '#2563EB', ink: '#0B1B33', edge: '#1D4ED8' },
  white: { top: '#FFFFFF', body: '#F4F6F8', ink: '#1C1F26', edge: '#C5CBD3' },
  orange: { top: '#F6B04A', body: '#EA580C', ink: '#2A1204', edge: '#C2410C' },
  red: { top: '#F07178', body: '#DC2626', ink: '#2A0A0C', edge: '#B91C1C' },
  purple: { top: '#B49AF8', body: '#7C3AED', ink: '#1A1030', edge: '#6D28D9' },
  empty: { top: '#F8F9FB', body: '#E6E8EE', ink: '#667085', edge: '#C5CAD3' }
};

const EYE_L = { cx: 22, cy: 31 };
const EYE_R = { cx: 42, cy: 31 };
const DOTS = [20, 32, 44] as const;

type PointerSample = { x: number; y: number; atMs: number };

const faces = new Set<(now: number) => void>();
let pointerSample: PointerSample | null = null;
let frame = 0;
let listening = false;

function onPointerMove(event: PointerEvent) {
  pointerSample = { x: event.clientX, y: event.clientY, atMs: performance.now() };
}

function tickFaces(now: number) {
  for (const face of faces) face(now);
  frame = faces.size > 0 ? requestAnimationFrame(tickFaces) : 0;
}

function subscribeFace(fn: (now: number) => void): () => void {
  faces.add(fn);
  if (!listening) {
    listening = true;
    window.addEventListener('pointermove', onPointerMove, { passive: true });
  }
  if (!frame) frame = requestAnimationFrame(tickFaces);
  return () => {
    faces.delete(fn);
    if (faces.size === 0 && listening) {
      listening = false;
      window.removeEventListener('pointermove', onPointerMove);
    }
  };
}

function eyeShape(cx: number, cy: number, open: number): string {
  return `translate(${cx} ${cy}) scale(1 ${open.toFixed(3)}) translate(${-cx} ${-cy})`;
}

function Eye({ cx, cy, ink, squint }: { cx: number; cy: number; ink: string; squint: boolean }) {
  const width = squint ? 14 : 13;
  const height = squint ? 9 : 22;
  return (
    <g data-eye="" data-cx={cx} data-cy={cy}>
      <rect x={cx - width / 2} y={cy - height / 2} width={width} height={height} rx={width / 2} fill={ink} />
    </g>
  );
}

/** Original rounded face. Same trimmed name keeps the same color. */
export function BotFace({ name, label, testId, size = 'sm', className, mood = 'idle' }: BotFaceProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const reactId = useId().replace(/:/g, '');
  const color = botFaceColor(name);
  const index = botFaceIndex(name);
  const paint = color ? PAINT[color] : PAINT.empty;
  const expression = expressionForMood(mood);
  const clipId = `bot-face-${reactId}`;
  const fillId = `bot-face-fill-${reactId}`;
  const classes = ['bot-face', size !== 'sm' ? `bot-face--${size}` : '', color ? '' : 'bot-face--empty', className]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;

    let blink = createBlinkClock(performance.now(), Math.random());
    let idle = nextIdleLook(performance.now(), Math.random(), Math.random());
    let shownX = 0;
    let shownY = 0;
    let last = performance.now();

    return subscribeFace((now) => {
      const root = svgRef.current;
      if (!root || document.hidden) return;
      const dt = Math.min(48, now - last);
      last = now;
      const current = expressionForMood(moodRef.current);
      const blinkStep = stepBlinkClock(blink, now, Math.random());
      blink = blinkStep.clock;
      if (now >= idle.untilMs) idle = nextIdleLook(now, Math.random(), Math.random());
      const rect = root.getBoundingClientRect();
      const pose = resolveEyePose({
        mood: moodRef.current,
        nowMs: now,
        pointer: pointerSample,
        faceCenter: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        idle
      });
      shownX = damp(shownX, pose.lookX, dt);
      shownY = damp(shownY, pose.lookY, dt);
      const scan = current === 'scan' ? toolScan((now % 1400) / 1400) : 0;
      const look = root.querySelector('[data-look]');
      look?.setAttribute('transform', `translate(${((shownX + scan) * 6.2).toFixed(2)} ${(shownY * 4.2).toFixed(2)})`);
      const openness = current === 'ellipsis' || current === 'scan' ? 1 : blinkStep.open;
      for (const eye of root.querySelectorAll('[data-eye]')) {
        const cx = Number(eye.getAttribute('data-cx'));
        const cy = Number(eye.getAttribute('data-cy'));
        eye.setAttribute('transform', eyeShape(cx, cy, openness));
      }
      const mouth = root.querySelector('[data-mouth]');
      if (mouth) {
        const amount = speakingMouth((now % 520) / 520);
        mouth.setAttribute('ry', (1.15 + amount * 3.3).toFixed(2));
      }
      const dotPhase = (now % 900) / 900;
      for (const dot of root.querySelectorAll('[data-dot]')) {
        const cx = Number(dot.getAttribute('data-cx'));
        const cy = Number(dot.getAttribute('data-cy'));
        const scale = ellipsisScale(Number(dot.getAttribute('data-i')), dotPhase);
        dot.setAttribute('transform', `translate(${cx} ${cy}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})`);
      }
      const sweep = root.querySelector('[data-sweep]');
      if (sweep) {
        const glow = 0.28 + 0.72 * (0.5 + 0.5 * Math.sin((now % 1400) / 1400 * Math.PI * 2));
        sweep.setAttribute('opacity', glow.toFixed(3));
      }
    });
  }, []);

  return (
    <svg
      ref={svgRef}
      className={classes}
      viewBox="0 0 64 64"
      data-testid={testId}
      data-bot-face={index === null ? 'empty' : String(index)}
      data-bot-color={color ?? 'empty'}
      data-face-mood={mood}
      data-face-expression={expression}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={paint.top} />
          <stop offset="1" stopColor={paint.body} />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x="3" y="5" width="58" height="54" rx="20" />
        </clipPath>
      </defs>
      <rect
        x="3"
        y="5"
        width="58"
        height="54"
        rx="20"
        fill={`url(#${fillId})`}
        stroke={paint.edge}
        strokeWidth="1.25"
        strokeDasharray={color ? undefined : '3 2.4'}
      />
      <g clipPath={`url(#${clipId})`}>
        <ellipse cx="24" cy="14" rx="16" ry="7" fill="#fff" opacity={color === 'white' ? 0.28 : 0.22} />
        <g data-look="">
          {expression === 'ellipsis' ? (
            DOTS.map((cx, i) => (
              <circle key={cx} data-dot="" data-i={i} data-cx={cx} data-cy="32" cx={cx} cy="32" r="3.6" fill={paint.ink} />
            ))
          ) : (
            <>
              <Eye cx={EYE_L.cx} cy={EYE_L.cy} ink={paint.ink} squint={expression === 'scan'} />
              <Eye cx={EYE_R.cx} cy={EYE_R.cy} ink={paint.ink} squint={expression === 'scan'} />
            </>
          )}
          {expression === 'talk' ? (
            <ellipse data-mouth="" cx="32" cy="48" rx="6" ry="2.2" fill={paint.ink} />
          ) : null}
          {expression === 'scan' ? (
            <path
              data-sweep=""
              d="M20 49c4-3.4 8-4.8 12-4.8s8 1.4 12 4.8"
              fill="none"
              stroke={paint.ink}
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0.45"
            />
          ) : null}
        </g>
      </g>
    </svg>
  );
}
