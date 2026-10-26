/**
 * Soft blob robot face. A seed picks a silhouette, a pastel, and a resting
 * expression. The drawing is a static SVG; classic geometric faces stay separate.
 * The hash is case-sensitive so "Ada" and "ada" can differ, matching nameHash.
 */

export const SOFT_BOT_SILHOUETTES = [
  'pebble',
  'squish',
  'capsule',
  'cloud',
  'drop',
  'bean',
  'nub',
  'pillow'
] as const;

export type SoftBotSilhouette = (typeof SOFT_BOT_SILHOUETTES)[number];

export const SOFT_BOT_COLORS = [
  'butter',
  'peach',
  'coral',
  'blush',
  'lilac',
  'sky',
  'mint',
  'sage',
  'sand',
  'ink'
] as const;

export type SoftBotColor = (typeof SOFT_BOT_COLORS)[number];

export const SOFT_BOT_EXPRESSIONS = [
  'neutral',
  'happy',
  'curious',
  'sleepy',
  'wink',
  'content',
  'wide',
  'shy'
] as const;

export type SoftBotExpression = (typeof SOFT_BOT_EXPRESSIONS)[number];

export const SOFT_BOT_SWATCH: Record<SoftBotColor, string> = {
  butter: '#F6C445',
  peach: '#FF9B6A',
  coral: '#FF6B6B',
  blush: '#F48FB1',
  lilac: '#B794F6',
  sky: '#7EB6FF',
  mint: '#5DCAA5',
  sage: '#8FBF7F',
  sand: '#E0B080',
  ink: '#3D4254'
};

export type SoftBotFace = {
  silhouette: SoftBotSilhouette;
  color: SoftBotColor;
  expression: SoftBotExpression;
};

export type SoftBotFaceOverrides = {
  silhouette?: SoftBotSilhouette | null;
  color?: SoftBotColor | null;
  expression?: SoftBotExpression | null;
};

export function isSoftBotSilhouette(value: unknown): value is SoftBotSilhouette {
  return typeof value === 'string' && (SOFT_BOT_SILHOUETTES as readonly string[]).includes(value);
}

export function isSoftBotColor(value: unknown): value is SoftBotColor {
  return typeof value === 'string' && (SOFT_BOT_COLORS as readonly string[]).includes(value);
}

export function isSoftBotExpression(value: unknown): value is SoftBotExpression {
  return typeof value === 'string' && (SOFT_BOT_EXPRESSIONS as readonly string[]).includes(value);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mix(hash: number, salt: number): number {
  return Math.imul(hash ^ salt, 0x85ebca6b) >>> 0;
}

function pick<T>(list: readonly T[], hash: number, salt: number): T {
  return list[mix(hash, salt) % list.length]!;
}

/** Stable look for a seed. A blank seed is still stable, just the empty-key mix. */
export function softBotFaceFromSeed(seed: string, overrides?: SoftBotFaceOverrides): SoftBotFace {
  const hash = hashSeed(seed);
  return {
    silhouette: isSoftBotSilhouette(overrides?.silhouette)
      ? overrides.silhouette
      : pick(SOFT_BOT_SILHOUETTES, hash, 0x9e3779b1),
    color: isSoftBotColor(overrides?.color) ? overrides.color : pick(SOFT_BOT_COLORS, hash, 0x7f4a7c15),
    expression: isSoftBotExpression(overrides?.expression)
      ? overrides.expression
      : pick(SOFT_BOT_EXPRESSIONS, hash, 0x165667b1)
  };
}

/** Prefer a known bot id. Fall back to the trimmed name so a draft still stays put. */
export function softBotFaceSeed(input: { id?: string | null; name?: string | null }): string {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id) return id;
  return typeof input.name === 'string' ? input.name.trim() : '';
}

const VIEW = 64;

/** One closed outline per silhouette, inside a 64 box with a little padding. */
export function softSilhouettePath(silhouette: SoftBotSilhouette): string {
  switch (silhouette) {
    case 'pebble':
      return 'M32 6C46 6 58 16 58 32C58 48 46 58 32 58C18 58 6 48 6 32C6 16 18 6 32 6Z';
    case 'squish':
      return 'M18 10H46C54 10 58 18 58 28V36C58 48 52 56 40 56H24C12 56 6 48 6 36V28C6 18 10 10 18 10Z';
    case 'capsule':
      return 'M24 8H40C50 8 56 16 56 28V36C56 48 50 56 40 56H24C14 56 8 48 8 36V28C8 16 14 8 24 8Z';
    case 'cloud':
      return 'M20 18C24 10 34 10 38 16C44 12 54 16 54 26C60 28 60 40 52 44C50 52 40 56 32 54C22 58 10 52 10 42C4 38 6 26 16 24C14 20 16 18 20 18Z';
    case 'drop':
      return 'M32 6C44 18 56 30 56 40C56 52 46 58 32 58C18 58 8 52 8 40C8 30 20 18 32 6Z';
    case 'bean':
      return 'M22 10C36 6 52 12 56 26C60 40 52 56 36 56C20 56 8 46 10 32C12 18 14 12 22 10Z';
    case 'nub':
      return 'M32 8C42 8 48 14 48 22C56 24 58 34 52 40C56 50 46 58 34 56C22 60 8 52 10 40C4 32 10 22 20 20C22 12 26 8 32 8Z';
    case 'pillow':
      return 'M16 14C24 6 40 6 48 14C58 18 60 32 54 42C58 52 46 58 34 56C22 60 8 52 10 40C4 28 8 18 16 14Z';
    default: {
      const unreachable: never = silhouette;
      return unreachable;
    }
  }
}

export type SoftEye = { cx: number; cy: number; rx: number; ry: number; open: boolean };

export type SoftMouth = { d: string };

export type SoftFaceParts = {
  eyes: [SoftEye, SoftEye];
  mouth: SoftMouth;
  blush: boolean;
};

/** Resting eyes and mouth, placed for the 64 viewBox. No motion. */
export function softFaceParts(expression: SoftBotExpression): SoftFaceParts {
  const left = 24;
  const right = 40;
  const eyeY = 30;
  switch (expression) {
    case 'neutral':
      return {
        eyes: [
          { cx: left, cy: eyeY, rx: 3.2, ry: 4.4, open: true },
          { cx: right, cy: eyeY, rx: 3.2, ry: 4.4, open: true }
        ],
        mouth: { d: `M28 44 H36` },
        blush: false
      };
    case 'happy':
      return {
        eyes: [
          { cx: left, cy: eyeY, rx: 3.2, ry: 4.2, open: true },
          { cx: right, cy: eyeY, rx: 3.2, ry: 4.2, open: true }
        ],
        mouth: { d: `M27 42 Q32 48 37 42` },
        blush: true
      };
    case 'curious':
      return {
        eyes: [
          { cx: left - 0.4, cy: eyeY - 1, rx: 3.4, ry: 4.6, open: true },
          { cx: right + 0.6, cy: eyeY - 1, rx: 3.6, ry: 5, open: true }
        ],
        mouth: { d: `M30 43 Q32 46 36 43` },
        blush: false
      };
    case 'sleepy':
      return {
        eyes: [
          { cx: left, cy: eyeY + 1, rx: 3.4, ry: 1.3, open: true },
          { cx: right, cy: eyeY + 1, rx: 3.4, ry: 1.3, open: true }
        ],
        mouth: { d: `M29 45 Q32 47 35 45` },
        blush: false
      };
    case 'wink':
      return {
        eyes: [
          { cx: left, cy: eyeY, rx: 3.2, ry: 4.4, open: true },
          { cx: right, cy: eyeY + 1, rx: 3.2, ry: 1.1, open: false }
        ],
        mouth: { d: `M28 43 Q32 47 36 42` },
        blush: true
      };
    case 'content':
      return {
        eyes: [
          { cx: left, cy: eyeY, rx: 3.3, ry: 2.2, open: true },
          { cx: right, cy: eyeY, rx: 3.3, ry: 2.2, open: true }
        ],
        mouth: { d: `M28 43 Q32 46 36 43` },
        blush: true
      };
    case 'wide':
      return {
        eyes: [
          { cx: left, cy: eyeY, rx: 3.8, ry: 5.1, open: true },
          { cx: right, cy: eyeY, rx: 3.8, ry: 5.1, open: true }
        ],
        mouth: { d: `M30 42 a2.2 2.4 0 1 0 4.4 0 a2.2 2.4 0 1 0 -4.4 0` },
        blush: false
      };
    case 'shy':
      return {
        eyes: [
          { cx: left, cy: eyeY + 0.6, rx: 3, ry: 3.2, open: true },
          { cx: right, cy: eyeY + 0.6, rx: 3, ry: 3.2, open: true }
        ],
        mouth: { d: `M29 44 Q32 46 35 44` },
        blush: true
      };
    default: {
      const unreachable: never = expression;
      return unreachable;
    }
  }
}

export function eyeInkForSoftColor(color: SoftBotColor): string {
  if (color === 'butter' || color === 'sand') return '#2A241C';
  return '#1C2430';
}

/** Static SVG markup. Callers that need DOM use SoftBotFace instead. */
export function renderSoftBotFaceSvg(face: SoftBotFace): string {
  const fill = SOFT_BOT_SWATCH[face.color];
  const ink = eyeInkForSoftColor(face.color);
  const parts = softFaceParts(face.expression);
  const eyes = parts.eyes
    .map((eye) => {
      if (!eye.open) {
        return `<path d="M${eye.cx - eye.rx} ${eye.cy} Q${eye.cx} ${eye.cy + 1.6} ${eye.cx + eye.rx} ${eye.cy}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`;
      }
      return `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}" fill="${ink}"/>`;
    })
    .join('');
  const blush = parts.blush
    ? `<ellipse cx="16" cy="38" rx="3.2" ry="1.8" fill="${ink}" opacity="0.18"/><ellipse cx="48" cy="38" rx="3.2" ry="1.8" fill="${ink}" opacity="0.18"/>`
    : '';
  const mouth = `<path d="${parts.mouth.d}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" data-soft-bot-face="${face.silhouette}" data-soft-bot-color="${face.color}" data-soft-bot-expression="${face.expression}"><path d="${softSilhouettePath(face.silhouette)}" fill="${fill}"/>${blush}${eyes}${mouth}</svg>`;
}
