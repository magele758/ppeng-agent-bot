'use client';

import { useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n';

import {
  eyeInkForSoftColor,
  softBotFaceFromSeed,
  softBotFaceSeed,
  softFaceParts,
  softSilhouettePath,
  SOFT_BOT_SWATCH,
  type SoftBotColor,
  type SoftBotExpression,
  type SoftBotSilhouette
} from '@/lib/soft-bot-face';
import { botFaceClassName, type BotFaceSize, type LivingFaceMood } from '@/lib/bot-face';

export interface SoftBotFaceProps {
  /** Stable seed. A bot id is preferred; a trimmed name is the fallback. */
  seed?: string | null;
  name?: string | null;
  id?: string | null;
  silhouette?: SoftBotSilhouette | null;
  color?: SoftBotColor | null;
  expression?: SoftBotExpression | null;
  label?: string;
  testId?: string;
  size?: BotFaceSize;
  className?: string;
  mood?: LivingFaceMood;
}

/** Saved soft appearance, with list idle motion and continuous work motion. */
export function SoftBotFace({
  seed,
  name,
  id,
  silhouette,
  color,
  expression,
  label,
  testId,
  size = 'sm',
  className,
  mood = 'idle'
}: SoftBotFaceProps) {
  const { t } = useI18n();
  const root = useRef<SVGSVGElement>(null);
  const working = mood !== 'idle';
  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    let visible = true;
    const sync = () => { svg.dataset.softMotionPaused = String(document.hidden || !visible); };
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; sync(); });
    observer.observe(svg);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, []);
  const face = softBotFaceFromSeed(seed ?? softBotFaceSeed({ id, name }), { silhouette, color, expression });
  const ink = eyeInkForSoftColor(face.color);
  const parts = softFaceParts(face.expression);
  const classes = botFaceClassName({ size, className });
  return (
    <svg
      ref={root}
      className={classes}
      data-face-mood={mood}
      data-face-working={working}
      viewBox="0 0 64 64"
      data-testid={testId}
      data-soft-bot-face={face.silhouette}
      data-soft-bot-color={face.color}
      data-soft-bot-expression={face.expression}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g data-bob="">
        <path d={softSilhouettePath(face.silhouette)} fill={SOFT_BOT_SWATCH[face.color]} />
        <g data-look="">
          {parts.blush ? (
            <g opacity="0.18" fill={ink}>
              <ellipse cx="16" cy="38" rx="3.2" ry="1.8" />
              <ellipse cx="48" cy="38" rx="3.2" ry="1.8" />
            </g>
          ) : null}
          <g data-eye="">
            {parts.eyes.map((eye) =>
              eye.open ? (
                <ellipse key={`${eye.cx}-${eye.cy}`} cx={eye.cx} cy={eye.cy} rx={eye.rx} ry={eye.ry} fill={ink} />
              ) : (
                <path
                  key={`${eye.cx}-wink`}
                  d={`M${eye.cx - eye.rx} ${eye.cy} Q${eye.cx} ${eye.cy + 1.6} ${eye.cx + eye.rx} ${eye.cy}`}
                  fill="none"
                  stroke={ink}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              )
            )}
          </g>
          <path data-soft-mouth="" d={parts.mouth.d} fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </g>
      {working ? <text className="bot-face__work-label" x="32" y="62" textAnchor="middle">{t('play.faceMotion.working')}</text> : null}
    </svg>
  );
}
