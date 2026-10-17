'use client';

import { useEffect, useId, useRef } from 'react';
import {
  BOT_FACE_SWATCH,
  HAPPY_BEAT_MS,
  avatarStandIn,
  avatarWhenNoFaceOverride,
  botFaceClassName,
  createBlinkClock,
  damp,
  drawnFaceView,
  ellipsisScale,
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
  turnFinishHappyUntil,
  type BotFaceColor,
  type BotFaceShape,
  type LivingFaceMood,
  type MouthKind
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

const DOTS = [-3.2, 0, 3.2] as const;

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

function eyeTransform(cx: number, cy: number, open: number, drop: number): string {
  return `translate(${cx} ${cy + drop}) scale(1 ${open.toFixed(3)}) translate(${-cx} ${-cy})`;
}

function Eye({ cx, cy, ink, width, height }: { cx: number; cy: number; ink: string; width: number; height: number }) {
  return (
    <g data-eye="" data-cx={cx} data-cy={cy}>
      <rect x={cx - width / 2} y={cy - height / 2} width={width} height={height} rx={width / 2} fill={ink} />
    </g>
  );
}

function Silhouette({ shape, fill, dashed }: { shape: BotFaceShape | 'empty'; fill?: string; dashed?: boolean }) {
  const stroke = dashed ? '#C5CAD3' : 'none';
  const dash = dashed ? '3 2.4' : undefined;
  switch (shape) {
    case 'empty':
    case 'squircle':
      return <rect x="6" y="6" width="52" height="52" rx="14" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'circle':
      return <circle cx="32" cy="32" r="26" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'tall':
      return <rect x="18" y="4" width="28" height="56" rx="14" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'cloud':
      return (
        <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash}>
          <ellipse cx="24" cy="36" rx="12" ry="10" />
          <ellipse cx="36" cy="30" rx="14" ry="12" />
          <ellipse cx="48" cy="36" rx="10" ry="9" />
          <rect x="16" y="34" width="36" height="12" rx="6" />
        </g>
      );
    case 'star':
      return <path d="M32 4 39 25 60 32 39 39 32 60 25 39 4 32 25 25Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'clover':
      return (
        <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash}>
          <circle cx="32" cy="16" r="12" />
          <circle cx="48" cy="32" r="12" />
          <circle cx="32" cy="48" r="12" />
          <circle cx="16" cy="32" r="12" />
          <circle cx="32" cy="32" r="8" />
        </g>
      );
    case 'heart':
      return (
        <path
          d="M32 54C14 40 8 28 15 20c6-7 14-4 17 3 3-7 11-10 17-3 7 8 1 20-17 34Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.2"
          strokeDasharray={dash}
        />
      );
    case 'flower':
      return (
        <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash}>
          <circle cx="32" cy="20" r="15" />
          <circle cx="43.41" cy="28.29" r="15" />
          <circle cx="39.05" cy="41.71" r="15" />
          <circle cx="24.95" cy="41.71" r="15" />
          <circle cx="20.59" cy="28.29" r="15" />
          <circle cx="32" cy="32" r="14" />
        </g>
      );
    case 'teardrop':
      return (
        <path
          d="M32 6C46 18 56 32 56 42 56 54 45 60 32 60 19 60 8 54 8 42 8 32 18 18 32 6Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.2"
          strokeDasharray={dash}
        />
      );
    case 'bean':
      return (
        <path
          d="M18 28c-8 2-10 14-4 18 10 8 28 8 38 2 8-4 10-14 4-18-8-6-28-8-38-2Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.2"
          strokeDasharray={dash}
        />
      );
    case 'triangle':
      return <path d="M32 8 58 54H6Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'house':
      return <path d="M32 6 58 28V58H6V28Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    case 'splat':
      return (
        <path
          d="M32 8c6 0 8 6 12 5 6-2 12 4 10 10 4 4 2 10 4 14 2 6-4 10-2 16-4 4-10 2-14 6-4 4-10 0-14-2-6 2-12-4-12-10-6-2-8-10-4-14-2-6 2-10 0-16 4-4 8-6 8-9 2-4 8-4 12 0Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.2"
          strokeDasharray={dash}
        />
      );
    case 'hexagon':
      return <path d="M32 6 54 18 54 46 32 58 10 46 10 18Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={dash} />;
    default: {
      const unreachable: never = shape;
      return unreachable;
    }
  }
}

function mouthVisible(kind: MouthKind): boolean {
  return kind !== 'rest';
}

/**
 * Original living icon. Resting face is a flat silhouette and two eyes.
 * Happy keeps a small smile; the heavier cute marks stay off the resting face.
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
  const avatar = avatarWhenNoFaceOverride(shapeProp, colorProp, saved.avatar);
  const standIn = avatarStandIn({ avatar, size, className, label });
  const showAvatar = standIn !== null;

  useEffect(() => {
    const until = turnFinishHappyUntil(prevMoodRef.current, mood, performance.now());
    prevMoodRef.current = mood;
    if (until !== null) happyUntilRef.current = until;
  }, [mood]);

  useEffect(() => {
    if (showAvatar) return;
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
      const targetY = gesture === 'sleepy' ? 0.28 : pose.lookY;
      shownX = damp(shownX, gesture === 'sleepy' ? 0 : pose.lookX, dt);
      shownY = damp(shownY, targetY, dt);
      let bob = 0;
      if (!reduced && gesture === 'hover' && hoverAtRef.current !== null) {
        bob = hoverDelight(now - hoverAtRef.current).dy * 0.45;
      } else if (!reduced && gesture === 'happy' && happyUntilRef.current !== null) {
        bob = happyBeat(now - (happyUntilRef.current - HAPPY_BEAT_MS)).dy * 0.4;
      } else if (!reduced && gesture === 'sleepy') {
        bob = sleepyBreath((now % 2800) / 2800) * 0.35;
      }
      root.querySelector('[data-bob]')?.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
      root.querySelector('[data-look]')?.setAttribute('transform', `translate(${(shownX * 3.4).toFixed(2)} ${(shownY * 2.2).toFixed(2)})`);
      const openness = gesture === 'sleepy' ? 0.34 * blinkStep.open : blinkStep.open;
      const drop = gesture === 'sleepy' ? 1.4 : 0;
      for (const eye of root.querySelectorAll('[data-eye]')) {
        const cx = Number(eye.getAttribute('data-cx'));
        const cy = Number(eye.getAttribute('data-cy'));
        eye.setAttribute('transform', eyeTransform(cx, cy, openness, drop));
      }
      const mouth = root.querySelector('[data-mouth]');
      if (mouth) {
        const y = Number(mouth.getAttribute('data-y'));
        const kind = mouthKindForGesture(gesture);
        const amount = gesture === 'talk' && !reduced ? speakingMouth((now % 520) / 520) : gesture === 'talk' ? 0.45 : 0;
        const ink = root.getAttribute('data-eye-ink') || '#fff';
        mouth.setAttribute('d', mouthPath(kind, y, amount));
        mouth.setAttribute('opacity', mouthVisible(kind) ? '1' : '0');
        if (kind === 'open' || kind === 'oh') {
          mouth.setAttribute('fill', ink);
          mouth.setAttribute('stroke', 'none');
        } else {
          mouth.setAttribute('fill', 'none');
          mouth.setAttribute('stroke', ink);
        }
      }
      const blush = root.querySelector('[data-blush]');
      blush?.setAttribute('opacity', gesture === 'happy' || gesture === 'hover' ? '0.16' : '0');
      const dotPhase = (now % 900) / 900;
      for (const dot of root.querySelectorAll('[data-dot]')) {
        const cx = Number(dot.getAttribute('data-cx'));
        const cy = Number(dot.getAttribute('data-cy'));
        const scale = reduced ? 1 : ellipsisScale(Number(dot.getAttribute('data-i')), dotPhase);
        dot.setAttribute('transform', `translate(${cx} ${cy}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})`);
      }
    });
  }, [showAvatar]);

  if (standIn?.kind === 'image') {
    return <img className={standIn.className} src={standIn.src} alt={standIn.alt} data-testid={testId} data-bot-avatar="image" />;
  }
  if (standIn?.kind === 'emoji') {
    return (
      <span className={standIn.className} role={standIn.label ? 'img' : 'presentation'} aria-label={standIn.label} aria-hidden={standIn.label ? undefined : true} data-testid={testId} data-bot-avatar="emoji">
        {standIn.text}
      </span>
    );
  }
  const view = drawnFaceView({ name, shape: shapeProp, color: colorProp, saved, mood });
  const layout = view.layout;
  const clipId = `bot-face-${reactId}`;
  const classes = botFaceClassName({ size, className, empty: view.empty });

  return (
    <svg
      ref={svgRef}
      className={classes}
      viewBox="0 0 64 64"
      data-testid={testId}
      data-bot-face={view.index === null ? 'empty' : String(view.index)}
      data-bot-color={view.color ?? 'empty'}
      data-bot-shape={view.shape ?? 'empty'}
      data-eye-ink={view.eyes}
      data-face-mood={mood}
      data-face-expression={view.expression}
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
        <clipPath id={clipId}>
          <Silhouette shape={view.drawnShape} />
        </clipPath>
      </defs>
      <g data-bob="">
        <Silhouette shape={view.drawnShape} fill={view.color ? BOT_FACE_SWATCH[view.color] : '#E6E8EE'} dashed={!view.color} />
        <g clipPath={`url(#${clipId})`}>
          <g data-blush="" opacity="0">
            <ellipse cx={layout.left - 7} cy={layout.eyeY + 8} rx="3.4" ry="1.7" fill="#000" />
            <ellipse cx={layout.right + 7} cy={layout.eyeY + 8} rx="3.4" ry="1.7" fill="#000" />
          </g>
          <g data-look="">
            <Eye cx={layout.left} cy={layout.eyeY} ink={view.eyes} width={view.eyeW} height={view.eyeH} />
            <Eye cx={layout.right} cy={layout.eyeY} ink={view.eyes} width={view.eyeW} height={view.eyeH} />
            <path
              data-mouth=""
              data-y={layout.mouthY}
              d={mouthPath(view.mouth, layout.mouthY, view.mouthOpen)}
              fill={view.mouth === 'open' || view.mouth === 'oh' ? view.eyes : 'none'}
              stroke={view.mouth === 'open' || view.mouth === 'oh' ? 'none' : view.eyes}
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity={mouthVisible(view.mouth) ? 1 : 0}
            />
          </g>
          {view.expression === 'ellipsis'
            ? DOTS.map((dx, i) => (
                <circle
                  key={dx}
                  data-dot=""
                  data-i={i}
                  data-cx={32 + dx}
                  data-cy={layout.markY}
                  cx={32 + dx}
                  cy={layout.markY}
                  r="1.35"
                  fill={view.eyes}
                />
              ))
            : null}
        </g>
      </g>
    </svg>
  );
}
