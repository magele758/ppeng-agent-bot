'use client';

import { useEffect, useId, useRef } from 'react';
import {
  HAPPY_BEAT_MS,
  botFaceIndex,
  createBlinkClock,
  damp,
  ellipsisScale,
  expressionForMood,
  happyBeat,
  hoverDelight,
  mouthKindForGesture,
  mouthPath,
  nextIdleLook,
  resolveBotFaceAppearance,
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
import { useSavedFace } from './BotFaceCatalog';
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
  /**
   * Explicit silhouette. `undefined` uses a saved bot choice, then the name.
   * `null` skips the saved choice and uses the name.
   */
  shape?: BotFaceShape | null;
  /** Explicit swatch. Same rules as `shape`. */
  color?: BotFaceColor | null;
}

type Paint = { top: string; mid: string; body: string; ink: string; edge: string };

const PAINT: Record<BotFaceColor | 'empty', Paint> = {
  blue: { top: '#D7E4FF', mid: '#7AA4F8', body: '#3B6EF5', ink: '#141820', edge: '#2C5ED6' },
  white: { top: '#FFFFFF', mid: '#F4F6FB', body: '#E4E7F2', ink: '#1A1D26', edge: '#D5D9E6' },
  orange: { top: '#FFE0C2', mid: '#FFB069', body: '#F97316', ink: '#1A120C', edge: '#EA580C' },
  red: { top: '#FFD0D0', mid: '#FB8A8A', body: '#EF4444', ink: '#1A1012', edge: '#DC2626' },
  purple: { top: '#E4DCFF', mid: '#B79AF8', body: '#8B5CF6', ink: '#161222', edge: '#7C3AED' },
  mint: { top: '#D9FFF4', mid: '#7EE8D6', body: '#2DD4BF', ink: '#10211E', edge: '#14B8A6' },
  pink: { top: '#FFD6E8', mid: '#F9A8D0', body: '#F472B6', ink: '#241018', edge: '#EC4899' },
  yellow: { top: '#FFF3C4', mid: '#FFE08A', body: '#F5C14A', ink: '#241C0C', edge: '#EAB308' },
  empty: { top: '#F8F9FB', mid: '#EEF0F4', body: '#E6E8EE', ink: '#667085', edge: '#C5CAD3' }
};

const BEAN = 'M30 5C48 2 61 14 61 32C61 52 46 62 30 61C16 60 6 50 8 38C10 28 16 30 16 22C16 12 18 8 30 5Z';

const DOTS = [-3.1, 0, 3.1] as const;

type FaceLayout = {
  left: number;
  right: number;
  eyeY: number;
  eyeW: number;
  eyeH: number;
  mouthY: number;
  badgeX: number;
  badgeY: number;
};

function layoutFor(shape: BotFaceShape | null): FaceLayout {
  switch (shape) {
    case 'tall':
      return { left: 26.5, right: 37.5, eyeY: 31, eyeW: 6.2, eyeH: 15, mouthY: 48, badgeX: 22, badgeY: 12 };
    case 'bean':
      return { left: 23, right: 41, eyeY: 32, eyeW: 7.6, eyeH: 16, mouthY: 48, badgeX: 15, badgeY: 14 };
    case 'circle':
      return { left: 23, right: 41, eyeY: 32, eyeW: 8, eyeH: 16.5, mouthY: 48, badgeX: 15, badgeY: 14 };
    case 'squircle':
    case null:
      return { left: 23, right: 41, eyeY: 32, eyeW: 8, eyeH: 16.5, mouthY: 48, badgeX: 13, badgeY: 13 };
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

function Eye({ cx, cy, ink, width, height }: { cx: number; cy: number; ink: string; width: number; height: number }) {
  return (
    <g data-eye="" data-cx={cx} data-cy={cy}>
      <rect x={cx - width / 2} y={cy - height / 2} width={width} height={height} rx={width / 2} fill={ink} />
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
        <rect x="3" y="3" width="58" height="58" rx="14" fill={fill} stroke={stroke} strokeWidth="1.15" strokeDasharray={dash} />
      );
    case 'circle':
      return <circle cx="32" cy="32" r="30" fill={fill} stroke={stroke} strokeWidth="1.15" strokeDasharray={dash} />;
    case 'tall':
      return (
        <rect x="16" y="2" width="32" height="60" rx="16" fill={fill} stroke={stroke} strokeWidth="1.15" strokeDasharray={dash} />
      );
    case 'bean':
      return <path d={BEAN} fill={fill} stroke={stroke} strokeWidth="1.15" strokeDasharray={dash} />;
    default: {
      const unreachable: never = shape;
      return unreachable;
    }
  }
}

/**
 * Original living icon. Plump silhouette, capsule eyes, and a thinking chip.
 * The drawing is not taken from Coucou; only the quiet menu-bar direction is.
 */
export function BotFace({
  name,
  label,
  testId,
  size = 'sm',
  className,
  mood = 'idle',
  shape: shapeProp,
  color: colorProp
}: BotFaceProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const moodRef = useRef(mood);
  const hoverAtRef = useRef<number | null>(null);
  const happyUntilRef = useRef<number | null>(null);
  const prevMoodRef = useRef(mood);
  moodRef.current = mood;
  const reactId = useId().replace(/:/g, '');
  const saved = useSavedFace(name);
  const appearance = resolveBotFaceAppearance({
    name,
    savedShape: shapeProp !== undefined ? shapeProp : saved.shape,
    savedColor: colorProp !== undefined ? colorProp : saved.color
  });
  const color = appearance.color;
  const shape = appearance.shape;
  const index = botFaceIndex(name);
  const paint = color ? PAINT[color] : PAINT.empty;
  const drawnShape: BotFaceShape | 'empty' = shape ?? (color ? 'squircle' : 'empty');
  const layout = layoutFor(shape);
  const expression = expressionForMood(mood);
  const eyeH = expression === 'scan' ? layout.eyeH * 0.52 : layout.eyeH;
  const clipId = `bot-face-${reactId}`;
  const fillId = `bot-face-fill-${reactId}`;
  const classes = ['bot-face', size !== 'sm' ? `bot-face--${size}` : '', color ? '' : 'bot-face--empty', className]
    .filter(Boolean)
    .join(' ');
  const showMouth = expression === 'talk';

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
      const blinkStep = reduced ? { clock: blink, open: 1 } : stepBlinkClock(blink, now, Math.random());
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
      const targetY = gesture === 'sleepy' ? 0.35 : pose.lookY;
      shownX = damp(shownX, gesture === 'sleepy' ? 0 : pose.lookX, dt);
      shownY = damp(shownY, targetY, dt);
      const scan = !reduced && gesture === 'scan' ? toolScan((now % 1400) / 1400) : 0;
      let bob = 0;
      if (!reduced && gesture === 'hover' && hoverAtRef.current !== null) {
        bob = hoverDelight(now - hoverAtRef.current).dy;
      } else if (!reduced && gesture === 'happy' && happyUntilRef.current !== null) {
        bob = happyBeat(now - (happyUntilRef.current - HAPPY_BEAT_MS)).dy;
      } else if (!reduced && gesture === 'sleepy') {
        bob = sleepyBreath((now % 2800) / 2800) * 0.45;
      }
      root.querySelector('[data-bob]')?.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
      root
        .querySelector('[data-look]')
        ?.setAttribute('transform', `translate(${((shownX + scan) * 4.2).toFixed(2)} ${(shownY * 2.6).toFixed(2)})`);
      const openness = gesture === 'sleepy' ? 0.46 * blinkStep.open : blinkStep.open;
      const drop = gesture === 'sleepy' ? 1.2 : 0;
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
          <stop offset="0.46" stopColor={paint.mid} />
          <stop offset="1" stopColor={paint.body} />
        </linearGradient>
        <clipPath id={clipId}>
          <Silhouette shape={drawnShape} />
        </clipPath>
      </defs>
      <g data-bob="">
        <Silhouette shape={drawnShape} fill={`url(#${fillId})`} edge={paint.edge} dashed={!color} />
        <g clipPath={`url(#${clipId})`}>
          <g data-look="">
            <Eye cx={layout.left} cy={layout.eyeY} ink={paint.ink} width={layout.eyeW} height={eyeH} />
            <Eye cx={layout.right} cy={layout.eyeY} ink={paint.ink} width={layout.eyeW} height={eyeH} />
            {showMouth ? (
              <path
                data-mouth=""
                data-y={layout.mouthY}
                d={mouthPath('open', layout.mouthY, 0.45)}
                fill="none"
                stroke={paint.ink}
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            ) : null}
          </g>
        </g>
        {expression === 'ellipsis' ? (
          <g data-badge="">
            <circle cx={layout.badgeX} cy={layout.badgeY} r="8" fill="#6E56CF" />
            {DOTS.map((dx, i) => (
              <circle
                key={dx}
                data-dot=""
                data-i={i}
                data-cx={layout.badgeX + dx}
                data-cy={layout.badgeY}
                cx={layout.badgeX + dx}
                cy={layout.badgeY}
                r="1.15"
                fill="#fff"
              />
            ))}
          </g>
        ) : null}
      </g>
    </svg>
  );
}
