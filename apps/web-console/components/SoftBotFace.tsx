'use client';

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
import { botFaceClassName, type BotFaceSize } from '@/lib/bot-face';

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
}

/**
 * Static soft blob face. List rows do not animate; a picker preview may add a
 * class that only moves on hover.
 */
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
  className
}: SoftBotFaceProps) {
  const face = softBotFaceFromSeed(seed ?? softBotFaceSeed({ id, name }), { silhouette, color, expression });
  const ink = eyeInkForSoftColor(face.color);
  const parts = softFaceParts(face.expression);
  const classes = botFaceClassName({ size, className });
  return (
    <svg
      className={classes}
      viewBox="0 0 64 64"
      data-testid={testId}
      data-soft-bot-face={face.silhouette}
      data-soft-bot-color={face.color}
      data-soft-bot-expression={face.expression}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={softSilhouettePath(face.silhouette)} fill={SOFT_BOT_SWATCH[face.color]} />
      {parts.blush ? (
        <g opacity="0.18" fill={ink}>
          <ellipse cx="16" cy="38" rx="3.2" ry="1.8" />
          <ellipse cx="48" cy="38" rx="3.2" ry="1.8" />
        </g>
      ) : null}
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
      <path d={parts.mouth.d} fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
