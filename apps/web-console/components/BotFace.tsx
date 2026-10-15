'use client';

import { useEffect, useId, useRef } from 'react';
import {
  HAPPY_BEAT_MS,
  botFaceColor,
  botFaceIndex,
  botFaceShape,
  createBlinkClock,
  damp,
  ellipsisScale,
  expressionForMood,
  happyBeat,
  hoverDelight,
  mouthKindForGesture,
  mouthPath,
  nextIdleLook,
  resolveEyePose,
  resolveFaceGesture,
  sleepyBreath,
  speakingMouth,
  stepBlinkClock,
  toolScan,
  turnFinishHappyUntil,
  type BotFaceColor,
  type BotFaceShape,
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

type Paint = {
  top: string;
  body: string;
  ink: string;
  edge: string;
  blush: string;
  blushOpacity: number;
};

const PAINT: Record<BotFaceColor | 'empty', Paint> = {
  blue: { top: '#93C5FD', body: '#3B82F6', ink: '#0B1B33', edge: '#1D4ED8', blush: '#FF8FAB', blushOpacity: 0.5 },
  white: { top: '#FFFFFF', body: '#F7F8FA', ink: '#2A3140', edge: '#C5CBD3', blush: '#F9A8D4', blushOpacity: 0.9 },
  orange: { top: '#FDBA74', body: '#F97316', ink: '#3A1604', edge: '#C2410C', blush: '#FFE4E6', blushOpacity: 0.62 },
  red: { top: '#FCA5A5', body: '#EF4444', ink: '#3F0A0A', edge: '#B91C1C', blush: '#FFE4E6', blushOpacity: 0.55 },
  purple: { top: '#DDD6FE', body: '#8B5CF6', ink: '#1E1033', edge: '#6D28D9', blush: '#FF8FAB', blushOpacity: 0.42 },
  mint: { top: '#99F6E4', body: '#14B8A6', ink: '#042F2E', edge: '#0F766E', blush: '#FF8FAB', blushOpacity: 0.48 },
  pink: { top: '#FBCFE8', body: '#F472B6', ink: '#4A1230', edge: '#DB2777', blush: '#FFF1F2', blushOpacity: 0.75 },
  yellow: { top: '#FDE68A', body: '#F5C14A', ink: '#3A2A08', edge: '#D97706', blush: '#FB7185', blushOpacity: 0.42 },
  empty: { top: '#F8F9FB', body: '#E6E8EE', ink: '#667085', edge: '#C5CAD3', blush: '#F9A8D4', blushOpacity: 0.5 }
};

const BEAN = 'M32 13C50 11 61 22 61 32C61 46 50 53 32 53C14 53 3 46 3 32C3 22 14 11 32 13Z';

const DOTS = [22, 32, 42] as const;

type FaceLayout = {
  left: number;
  right: number;
  eyeY: number;
  mouthY: number;
  cheekY: number;
  cheekL: number;
  cheekR: number;
};

function layoutFor(shape: BotFaceShape | null): FaceLayout {
  switch (shape) {
    case 'tall':
      return { left: 26, right: 38, eyeY: 28, mouthY: 44, cheekY: 36, cheekL: 23, cheekR: 41 };
    case 'bean':
      return { left: 22, right: 42, eyeY: 30, mouthY: 41, cheekY: 36, cheekL: 17, cheekR: 47 };
    case 'circle':
      return { left: 24, right: 40, eyeY: 30, mouthY: 43, cheekY: 37, cheekL: 18, cheekR: 46 };
    case 'squircle':
    case null:
      return { left: 24, right: 40, eyeY: 30, mouthY: 43, cheekY: 37, cheekL: 18, cheekR: 46 };
    default: {
      const unreachable: never = shape;
      return unreachable;
    }
  }
}

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

function eyeShape(cx: number, cy: number, open: number, drop: number): string {
  return `translate(${cx} ${cy + drop}) scale(1 ${open.toFixed(3)}) translate(${-cx} ${-cy})`;
}

function Eye({ cx, cy, ink }: { cx: number; cy: number; ink: string }) {
  return (
    <g data-eye="" data-cx={cx} data-cy={cy}>
      <circle cx={cx} cy={cy} r="5.6" fill={ink} />
      <circle cx={cx - 1.6} cy={cy - 1.9} r="1.65" fill="#fff" opacity="0.92" />
    </g>
  );
}

function Silhouette({
  shape,
  fill,
  edge,
  dashed
}: {
  shape: BotFaceShape | 'empty';
  fill?: string;
  edge?: string;
  dashed?: boolean;
}) {
  const stroke = edge ?? 'none';
  const dash = dashed ? '3 2.4' : undefined;
  switch (shape) {
    case 'empty':
    case 'squircle':
      return (
        <rect x="5" y="8" width="54" height="48" rx="22" fill={fill} stroke={stroke} strokeWidth="1.35" strokeDasharray={dash} />
      );
    case 'circle':
      return <circle cx="32" cy="32" r="26" fill={fill} stroke={stroke} strokeWidth="1.35" strokeDasharray={dash} />;
    case 'tall':
      return (
        <rect x="16" y="3" width="32" height="58" rx="16" fill={fill} stroke={stroke} strokeWidth="1.35" strokeDasharray={dash} />
      );
    case 'bean':
      return <path d={BEAN} fill={fill} stroke={stroke} strokeWidth="1.35" strokeDasharray={dash} />;
    default: {
      const unreachable: never = shape;
      return unreachable;
    }
  }
}

/** Original living face. The trimmed name keeps the same color and silhouette. */
export function BotFace({ name, label, testId, size = 'sm', className, mood = 'idle' }: BotFaceProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const moodRef = useRef(mood);
  const hoverAtRef = useRef<number | null>(null);
  const happyUntilRef = useRef<number | null>(null);
  const prevMoodRef = useRef(mood);
  moodRef.current = mood;
  const reactId = useId().replace(/:/g, '');
  const color = botFaceColor(name);
  const shape = botFaceShape(name);
  const index = botFaceIndex(name);
  const paint = color ? PAINT[color] : PAINT.empty;
  const drawnShape: BotFaceShape | 'empty' = shape ?? 'empty';
  const layout = layoutFor(shape);
  const expression = expressionForMood(mood);
  const clipId = `bot-face-${reactId}`;
  const fillId = `bot-face-fill-${reactId}`;
  const classes = ['bot-face', size !== 'sm' ? `bot-face--${size}` : '', color ? '' : 'bot-face--empty', className]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    const until = turnFinishHappyUntil(prevMoodRef.current, mood, performance.now());
    prevMoodRef.current = mood;
    if (until !== null) happyUntilRef.current = until;
  }, [mood]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let blink = createBlinkClock(performance.now(), Math.random());
    let idle = nextIdleLook(performance.now(), Math.random(), Math.random());
    let shownX = 0;
    let shownY = 0;
    let last = performance.now();

    return subscribeFace((now) => {
      const root = svgRef.current;
      if (!root || document.hidden) return;
      const reduced = motion.matches;
      const dt = Math.min(48, now - last);
      last = now;
      const hovering = hoverAtRef.current !== null;
      const pointerAge = pointerSample ? now - pointerSample.atMs : null;
      const gesture = resolveFaceGesture({
        mood: moodRef.current,
        hovering,
        pointerAgeMs: pointerAge,
        nowMs: now,
        happyUntilMs: happyUntilRef.current
      });
      root.setAttribute('data-face-gesture', gesture);
      const blinkStep = reduced
        ? { clock: blink, open: 1 }
        : stepBlinkClock(blink, now, Math.random());
      blink = blinkStep.clock;
      if (!reduced && now >= idle.untilMs) idle = nextIdleLook(now, Math.random(), Math.random());
      const rect = root.getBoundingClientRect();
      const pose = resolveEyePose({
        mood: moodRef.current,
        nowMs: now,
        pointer: pointerSample,
        faceCenter: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        idle
      });
      const targetY = gesture === 'sleepy' ? 0.5 : pose.lookY;
      shownX = damp(shownX, gesture === 'sleepy' ? 0 : pose.lookX, dt);
      shownY = damp(shownY, targetY, dt);
      const scan = !reduced && gesture === 'scan' ? toolScan((now % 1400) / 1400) : 0;
      let bob = 0;
      if (!reduced && gesture === 'hover' && hoverAtRef.current !== null) {
        bob = hoverDelight(now - hoverAtRef.current).dy;
      } else if (!reduced && gesture === 'happy' && happyUntilRef.current !== null) {
        bob = happyBeat(now - (happyUntilRef.current - HAPPY_BEAT_MS)).dy;
      } else if (!reduced && gesture === 'sleepy') {
        bob = sleepyBreath((now % 2800) / 2800);
      }
      root.querySelector('[data-bob]')?.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
      root
        .querySelector('[data-look]')
        ?.setAttribute('transform', `translate(${((shownX + scan) * 5.2).toFixed(2)} ${(shownY * 3.4).toFixed(2)})`);
      const openness =
        gesture === 'ellipsis' || gesture === 'scan' ? 1 : gesture === 'sleepy' ? 0.42 * blinkStep.open : blinkStep.open;
      const drop = gesture === 'sleepy' ? 1.6 : 0;
      for (const eye of root.querySelectorAll('[data-eye]')) {
        const cx = Number(eye.getAttribute('data-cx'));
        const cy = Number(eye.getAttribute('data-cy'));
        eye.setAttribute('transform', eyeShape(cx, cy, openness, drop));
      }
      const mouth = root.querySelector('[data-mouth]');
      if (mouth) {
        const y = Number(mouth.getAttribute('data-y'));
        const amount = gesture === 'talk' && !reduced ? speakingMouth((now % 520) / 520) : gesture === 'talk' ? 0.45 : 0;
        mouth.setAttribute('d', mouthPath(mouthKindForGesture(gesture), y, amount));
      }
      const dotPhase = (now % 900) / 900;
      for (const dot of root.querySelectorAll('[data-dot]')) {
        const cx = Number(dot.getAttribute('data-cx'));
        const cy = Number(dot.getAttribute('data-cy'));
        const scale = reduced ? 1 : ellipsisScale(Number(dot.getAttribute('data-i')), dotPhase);
        dot.setAttribute('transform', `translate(${cx} ${cy}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})`);
      }
      const sweep = root.querySelector('[data-sweep]');
      if (sweep && !reduced) {
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
      data-bot-shape={shape ?? 'empty'}
      data-face-mood={mood}
      data-face-expression={expression}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onPointerEnter={() => {
        hoverAtRef.current = performance.now();
      }}
      onPointerLeave={() => {
        hoverAtRef.current = null;
      }}
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={paint.top} />
          <stop offset="1" stopColor={paint.body} />
        </linearGradient>
        <clipPath id={clipId}>
          <Silhouette shape={drawnShape} />
        </clipPath>
      </defs>
      <g data-bob="">
        <Silhouette shape={drawnShape} fill={`url(#${fillId})`} edge={paint.edge} dashed={!color} />
        <g clipPath={`url(#${clipId})`}>
          <ellipse cx="26" cy="16" rx="14" ry="6" fill="#fff" opacity={color === 'white' ? 0.45 : 0.28} />
          <ellipse
            cx={layout.cheekL}
            cy={layout.cheekY}
            rx="4.4"
            ry="2.6"
            fill={paint.blush}
            opacity={paint.blushOpacity}
          />
          <ellipse
            cx={layout.cheekR}
            cy={layout.cheekY}
            rx="4.4"
            ry="2.6"
            fill={paint.blush}
            opacity={paint.blushOpacity}
          />
          <g data-look="">
            {expression === 'ellipsis' ? (
              DOTS.map((cx, i) => (
                <circle
                  key={cx}
                  data-dot=""
                  data-i={i}
                  data-cx={cx}
                  data-cy={layout.eyeY}
                  cx={cx}
                  cy={layout.eyeY}
                  r="3.5"
                  fill={paint.ink}
                />
              ))
            ) : (
              <>
                <Eye cx={layout.left} cy={layout.eyeY} ink={paint.ink} />
                <Eye cx={layout.right} cy={layout.eyeY} ink={paint.ink} />
              </>
            )}
            <path
              data-mouth=""
              data-y={layout.mouthY}
              d={mouthPath('rest', layout.mouthY)}
              fill="none"
              stroke={paint.ink}
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            {expression === 'scan' ? (
              <path
                data-sweep=""
                d={`M${layout.left - 2} ${layout.mouthY + 6}c4-3 8-4 12-4s8 1 12 4`}
                fill="none"
                stroke={paint.ink}
                strokeWidth="1.6"
                strokeLinecap="round"
                opacity="0.45"
              />
            ) : null}
          </g>
        </g>
      </g>
    </svg>
  );
}
