/**
 * Bot face identity and motion.
 * Geometry lives in `BotFace` (original vectors). This module only decides
 * which color a name keeps, and how the face moves: blink, idle glance,
 * pointer gaze, and conversation mood.
 * The name hash is case-sensitive on purpose so "Ada" and "ada" can differ.
 */

export const BOT_FACE_COUNT = 8;

const FACE_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export type BotFaceIndex = (typeof FACE_INDEXES)[number];

/** Colors offered in the picker. Order matches the swatch row. */
export const BOT_FACE_PICKER_COLORS = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray'
] as const;

/** Older saves still render. They are not offered for new choices. */
export const BOT_FACE_LEGACY_COLORS = ['white', 'mint'] as const;

export const BOT_FACE_COLORS = [...BOT_FACE_PICKER_COLORS, ...BOT_FACE_LEGACY_COLORS] as const;

export type BotFaceColor = (typeof BOT_FACE_COLORS)[number];

/** Silhouettes in the create/edit grid, left to right, top to bottom. */
export const BOT_FACE_PICKER_SHAPES = [
  'circle',
  'cloud',
  'squircle',
  'star',
  'clover',
  'heart',
  'flower',
  'teardrop',
  'bean',
  'triangle',
  'house',
  'splat',
  'hexagon'
] as const;

export const BOT_FACE_LEGACY_SHAPES = ['tall'] as const;

export const BOT_FACE_SHAPES = [...BOT_FACE_PICKER_SHAPES, ...BOT_FACE_LEGACY_SHAPES] as const;

export type BotFaceShape = (typeof BOT_FACE_SHAPES)[number];

/** Flat body color. The resting face is a solid silhouette, not a gradient sticker. */
export const BOT_FACE_SWATCH: Record<BotFaceColor, string> = {
  black: '#1C1C1E',
  brown: '#8D5A3B',
  red: '#F43F3F',
  orange: '#FF7A1A',
  yellow: '#FFB000',
  green: '#3CB44A',
  teal: '#1AAE9F',
  blue: '#2F6BFF',
  purple: '#7C4DFF',
  pink: '#FF4F93',
  gray: '#8E8E93',
  white: '#F4F5F7',
  mint: '#2DD4BF'
};

export function isBotFaceShape(value: unknown): value is BotFaceShape {
  return typeof value === 'string' && (BOT_FACE_SHAPES as readonly string[]).includes(value);
}

export function isBotFaceColor(value: unknown): value is BotFaceColor {
  return typeof value === 'string' && (BOT_FACE_COLORS as readonly string[]).includes(value);
}

/**
 * A saved choice wins. Anything else, including a blank save, keeps the name hash.
 * A blank name with no save is the empty face.
 */
export function resolveBotFaceAppearance(input: {
  name?: string | null;
  savedShape?: unknown;
  savedColor?: unknown;
}): { shape: BotFaceShape | null; color: BotFaceColor | null } {
  return {
    shape: isBotFaceShape(input.savedShape) ? input.savedShape : botFaceShape(input.name),
    color: isBotFaceColor(input.savedColor) ? input.savedColor : botFaceColor(input.name)
  };
}

/**
 * Preview props for the face picker.
 * Nothing chosen yet keeps a saved emoji or image (no shape/color override).
 * A chosen silhouette or swatch is passed through; the other axis stays unset
 * so the name (or a saved choice) still fills it.
 */
function previewAxis<T extends string>(chosen: T | null): T | undefined {
  if (chosen === null) return undefined;
  return chosen;
}

export function previewFaceChoice(
  shape: BotFaceShape | null,
  color: BotFaceColor | null,
  shown: { shape: BotFaceShape | null; color: BotFaceColor | null }
): { shape?: BotFaceShape; color?: BotFaceColor } {
  if (shape === null && color === null) return {};
  const nextShape = previewAxis(shape);
  const nextColor = previewAxis(color);
  return {
    ...(nextShape !== undefined ? { shape: nextShape } : {}),
    ...(nextColor !== undefined ? { color: nextColor } : {})
  };
}

export type SavedFaceEntry = {
  shape: BotFaceShape | null;
  color: BotFaceColor | null;
  avatar: string | null;
};

export type FaceCatalogBot = {
  name: string;
  faceShape?: string | null;
  faceColor?: string | null;
  avatar?: string | null;
};

function savedAvatarText(avatar: unknown): string | null {
  return typeof avatar === 'string' && avatar.trim() ? avatar.trim() : null;
}

function faceHasSave(face: SavedFaceEntry): boolean {
  return Boolean(face.shape || face.color || face.avatar);
}

function savedFaceEntry(bot: FaceCatalogBot): { key: string; face: SavedFaceEntry } | null {
  const key = bot.name.trim();
  if (!key) return null;
  const face = {
    shape: isBotFaceShape(bot.faceShape) ? bot.faceShape : null,
    color: isBotFaceColor(bot.faceColor) ? bot.faceColor : null,
    avatar: savedAvatarText(bot.avatar)
  };
  if (!faceHasSave(face)) return null;
  return { key, face };
}

/** Index saved faces by trimmed name. Blank names and faces with nothing saved are skipped. */
export function indexSavedFaces(bots: readonly FaceCatalogBot[]): Map<string, SavedFaceEntry> {
  const next = new Map<string, SavedFaceEntry>();
  for (const bot of bots) {
    const entry = savedFaceEntry(bot);
    if (entry) next.set(entry.key, entry.face);
  }
  return next;
}

/** An http(s) avatar renders as an image; anything else saved is treated as emoji text. */
export function isAvatarImageUrl(avatar: string | null): boolean {
  return avatar !== null && /^https?:\/\//i.test(avatar);
}

/** Saved avatar shows only when the caller did not pass an explicit shape or color. */
export function avatarWhenNoFaceOverride(
  shape: BotFaceShape | null | undefined,
  color: BotFaceColor | null | undefined,
  savedAvatar: string | null
): string | null {
  return shape === undefined && color === undefined ? savedAvatar : null;
}

export type BotFaceSize = 'sm' | 'md' | 'lg';

/** Class list shared by the svg face and the avatar stand-in. */
export function botFaceClassName(input: {
  size: BotFaceSize;
  className?: string;
  avatar?: boolean;
  empty?: boolean;
}): string {
  const sizeClass = input.size !== 'sm' ? `bot-face--${input.size}` : '';
  const kind = input.avatar ? 'bot-face--avatar' : input.empty ? 'bot-face--empty' : '';
  return ['bot-face', kind, sizeClass, input.className ?? ''].filter((part) => part.length > 0).join(' ');
}

export type AvatarStandIn =
  | { kind: 'image'; className: string; src: string; alt: string }
  | { kind: 'emoji'; className: string; text: string; label: string | undefined };

/**
 * How a saved avatar is drawn. Null means "draw the geometric face instead".
 * An http(s) value is an image; anything else is emoji text.
 */
export function avatarStandIn(input: {
  avatar: string | null;
  size: BotFaceSize;
  className?: string;
  label?: string;
}): AvatarStandIn | null {
  if (!input.avatar) return null;
  const className = botFaceClassName({ size: input.size, className: input.className, avatar: true });
  if (isAvatarImageUrl(input.avatar)) {
    return { kind: 'image', className, src: input.avatar, alt: input.label ?? '' };
  }
  return { kind: 'emoji', className, text: input.avatar, label: input.label };
}

/** Light silhouettes need dark eyes. An empty face uses the placeholder gray. */
export function eyeInkForColor(color: BotFaceColor | null): string {
  if (color === 'yellow' || color === 'white') return '#1A1A1A';
  if (!color) return '#667085';
  return '#FFFFFF';
}

export type DrawnFaceView = {
  shape: BotFaceShape | null;
  color: BotFaceColor | null;
  drawnShape: BotFaceShape | 'empty';
  index: BotFaceIndex | null;
  eyes: string;
  eyeW: number;
  eyeH: number;
  mouth: MouthKind;
  mouthOpen: number;
  empty: boolean;
  expression: LivingFaceExpression;
  layout: FaceLayout;
};

export type FaceLayout = {
  left: number;
  right: number;
  eyeY: number;
  eyeW: number;
  eyeH: number;
  mouthY: number;
  markY: number;
};

const FACE_LAYOUTS: Record<BotFaceShape, FaceLayout> = {
  triangle: { left: 27, right: 37, eyeY: 40, eyeW: 4.6, eyeH: 10, mouthY: 48, markY: 28 },
  house: { left: 26, right: 38, eyeY: 40, eyeW: 4.8, eyeH: 11, mouthY: 50, markY: 22 },
  teardrop: { left: 26, right: 38, eyeY: 40, eyeW: 5.2, eyeH: 13, mouthY: 50, markY: 22 },
  heart: { left: 26, right: 38, eyeY: 34, eyeW: 4.8, eyeH: 11, mouthY: 44, markY: 18 },
  star: { left: 27, right: 37, eyeY: 33, eyeW: 4.2, eyeH: 9, mouthY: 42, markY: 18 },
  tall: { left: 27, right: 37, eyeY: 32, eyeW: 5, eyeH: 13, mouthY: 46, markY: 16 },
  bean: { left: 24, right: 40, eyeY: 33, eyeW: 5, eyeH: 11, mouthY: 42, markY: 18 },
  flower: { left: 26.5, right: 37.5, eyeY: 32, eyeW: 5.2, eyeH: 12, mouthY: 44, markY: 14 },
  cloud: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 },
  clover: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 },
  splat: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 },
  hexagon: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 },
  circle: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 },
  squircle: { left: 26, right: 38, eyeY: 33, eyeW: 5.4, eyeH: 13, mouthY: 46, markY: 16 }
};

const DEFAULT_FACE_LAYOUT = FACE_LAYOUTS.circle;

/** Eye and mouth placement for one silhouette. A blank shape uses the default face. */
export function faceLayout(shape: BotFaceShape | null): FaceLayout {
  if (!shape) return DEFAULT_FACE_LAYOUT;
  return FACE_LAYOUTS[shape];
}

/**
 * Everything the resting svg needs besides layout geometry.
 * A surprised face uses round eyes; talk and surprise open the mouth.
 */
export function drawnFaceView(input: {
  name?: string | null;
  shape?: BotFaceShape | null;
  color?: BotFaceColor | null;
  saved: { shape: BotFaceShape | null; color: BotFaceColor | null };
  mood: LivingFaceMood;
}): DrawnFaceView {
  const appearance = resolveDrawnFace(input);
  const expression = expressionForMood(input.mood);
  const mouth = restingMouth(expression);
  const layout = faceLayout(layoutShapeFor(appearance));
  const round = expression === 'surprised';
  return {
    shape: appearance.shape,
    color: appearance.color,
    drawnShape: drawnSilhouette(appearance.shape, appearance.color),
    index: botFaceIndex(input.name),
    eyes: eyeInkForColor(appearance.color),
    eyeW: round ? 8.2 : layout.eyeW,
    eyeH: round ? 8.2 : layout.eyeH,
    mouth: mouth.kind,
    mouthOpen: mouth.open,
    empty: !appearance.color,
    expression,
    layout
  };
}

/** Eyes and mouth sit on the same silhouette the outline uses. */
function layoutShapeFor(appearance: { shape: BotFaceShape | null; color: BotFaceColor | null }): BotFaceShape | null {
  if (appearance.shape) return appearance.shape;
  return appearance.color ? 'circle' : null;
}

function drawnSilhouette(shape: BotFaceShape | null, color: BotFaceColor | null): BotFaceShape | 'empty' {
  if (shape) return shape;
  return color ? 'circle' : 'empty';
}

function restingMouth(expression: LivingFaceExpression): { kind: MouthKind; open: number } {
  if (expression === 'talk') return { kind: 'open', open: 0.45 };
  if (expression === 'surprised') return { kind: 'oh', open: 0 };
  return { kind: expression === 'rest' ? 'smile' : 'rest', open: 0 };
}

/**
 * Face the component draws.
 * An explicit prop wins, including `null` (skip the save, use the name).
 * An omitted prop falls through to the catalog, then the name hash.
 */
export function resolveDrawnFace(input: {
  name?: string | null;
  shape?: BotFaceShape | null;
  color?: BotFaceColor | null;
  saved: { shape: BotFaceShape | null; color: BotFaceColor | null };
}): { shape: BotFaceShape | null; color: BotFaceColor | null } {
  return resolveBotFaceAppearance({
    name: input.name,
    savedShape: input.shape !== undefined ? input.shape : input.saved.shape,
    savedColor: input.color !== undefined ? input.color : input.saved.color
  });
}

/** What the detail header passes to BotFace. Null axes are omitted so the save still shows. */
export function detailFaceProps(
  shape: BotFaceShape | null,
  color: BotFaceColor | null
): { shape?: BotFaceShape; color?: BotFaceColor } {
  return {
    ...(shape !== null ? { shape } : {}),
    ...(color !== null ? { color } : {})
  };
}

export const LIVING_FACE_MOODS = ['idle', 'thinking', 'speaking', 'tool'] as const;

export type LivingFaceMood = (typeof LIVING_FACE_MOODS)[number];

export type LivingFaceExpression = 'rest' | 'ellipsis' | 'talk' | 'surprised';

export type MouthKind = 'rest' | 'smile' | 'sleepy' | 'open' | 'oh';

/** Blank names use the empty-state placeholder instead of a named face. */
export function botFaceIndex(name: string | null | undefined): BotFaceIndex | null {
  if (typeof name !== 'string') return null;
  const key = name.trim();
  if (!key) return null;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return FACE_INDEXES[(hash >>> 0) % BOT_FACE_COUNT]!;
}

function nameHash(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A negative phase starts each list face mid-cycle, without random hydration changes. */
export function botFaceIdleDelay(name: string): string {
  return `-${nameHash(name) % 8800}ms`;
}

function namedKey(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const key = name.trim();
  return key ? key : null;
}

/** Stable swatch for a trimmed name. Independent of the legacy face index. */
export function botFaceColor(name: string | null | undefined): BotFaceColor | null {
  const key = namedKey(name);
  if (!key) return null;
  const hash = nameHash(key);
  const mixed = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995) >>> 0;
  return BOT_FACE_PICKER_COLORS[mixed % BOT_FACE_PICKER_COLORS.length]!;
}

/** Stable silhouette for a trimmed name. Independent of the color mix. */
export function botFaceShape(name: string | null | undefined): BotFaceShape | null {
  const key = namedKey(name);
  if (!key) return null;
  const hash = nameHash(key);
  const mixed = Math.imul(hash ^ (hash >>> 19), 0x85ebca6b) >>> 0;
  return BOT_FACE_PICKER_SHAPES[mixed % BOT_FACE_PICKER_SHAPES.length]!;
}

export type FaceSegment = { kind: string };

/**
 * Live turn → expression.
 * The newest stream segment wins: a tool call covers text, text covers reasoning.
 * A turn with no tokens yet reads as thinking. A finished turn is idle.
 */
export function resolveLivingFaceMood(input: {
  live: boolean;
  segments?: readonly FaceSegment[] | null;
}): LivingFaceMood {
  if (!input.live) return 'idle';
  const segments = input.segments ?? [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const kind = segments[i]!.kind;
    if (kind === 'tool') return 'tool';
    if (kind === 'text') return 'speaking';
    if (kind === 'reasoning') return 'thinking';
  }
  return 'thinking';
}

export function expressionForMood(mood: LivingFaceMood): LivingFaceExpression {
  switch (mood) {
    case 'idle':
      return 'rest';
    case 'thinking':
      return 'ellipsis';
    case 'speaking':
      return 'talk';
    case 'tool':
      return 'surprised';
    default: {
      const unreachable: never = mood;
      return unreachable;
    }
  }
}

export const BLINK_CLOSE_MS = 68;
export const BLINK_OPEN_MS = 108;
export const BLINK_SPAN_MS = BLINK_CLOSE_MS + BLINK_OPEN_MS;

const DOUBLE_BLINK_CHANCE = 0.18;
const DOUBLE_BLINK_GAP_MS = 150;
const BLINK_MIN_GAP_MS = 2100;
const BLINK_GAP_SPAN_MS = 2700;
const CLOSED_OPENNESS = 0.14;

export type BlinkClock = {
  nextAtMs: number;
  startedAtMs: number | null;
  followAtMs: number | null;
};

export function createBlinkClock(nowMs: number, random01: number): BlinkClock {
  return {
    nextAtMs: nowMs + 700 + clamp01(random01) * 1600,
    startedAtMs: null,
    followAtMs: null
  };
}

/** 1 = open, ~0.14 = shut. `startedAtMs` null means resting open. */
export function blinkOpenness(nowMs: number, startedAtMs: number | null): number {
  if (startedAtMs === null) return 1;
  const elapsed = nowMs - startedAtMs;
  if (elapsed <= 0) return 1;
  if (elapsed < BLINK_CLOSE_MS) {
    const p = elapsed / BLINK_CLOSE_MS;
    return 1 - (1 - CLOSED_OPENNESS) * p * p;
  }
  if (elapsed < BLINK_SPAN_MS) {
    const p = (elapsed - BLINK_CLOSE_MS) / BLINK_OPEN_MS;
    const eased = 1 - (1 - p) * (1 - p);
    return CLOSED_OPENNESS + (1 - CLOSED_OPENNESS) * eased;
  }
  return 1;
}

/**
 * Advance one blink clock. `random01` is only consumed when a blink starts.
 * A low roll schedules a second blink just after this one finishes.
 */
export function stepBlinkClock(
  clock: BlinkClock,
  nowMs: number,
  random01: number
): { clock: BlinkClock; open: number } {
  let next = clock;
  if (next.startedAtMs !== null && nowMs - next.startedAtMs >= BLINK_SPAN_MS) {
    next = {
      startedAtMs: null,
      followAtMs: null,
      nextAtMs: next.followAtMs ?? next.nextAtMs
    };
  }
  if (next.startedAtMs === null && nowMs >= next.nextAtMs) {
    const roll = clamp01(random01);
    const double = roll < DOUBLE_BLINK_CHANCE;
    const followAtMs = double ? nowMs + BLINK_SPAN_MS + DOUBLE_BLINK_GAP_MS : null;
    const gap = BLINK_MIN_GAP_MS + roll * BLINK_GAP_SPAN_MS;
    next = {
      startedAtMs: nowMs,
      followAtMs,
      nextAtMs: followAtMs ?? nowMs + BLINK_SPAN_MS + gap
    };
  }
  return { clock: next, open: blinkOpenness(nowMs, next.startedAtMs) };
}

export type IdleLook = { x: number; y: number; untilMs: number };

/** A short glance while nothing else is steering the eyes. x/y are about -1…1. */
export function nextIdleLook(nowMs: number, randomX: number, randomY: number): IdleLook {
  const x = clamp01(randomX) * 2 - 1;
  const y = clamp01(randomY) * 2 - 1;
  return {
    x: x * 0.62,
    y: y * 0.36,
    untilMs: nowMs + 680 + clamp01(randomY) * 1200
  };
}

/** Pointer relative to the face center, saturated so the eyes stay on the face. */
export function faceGaze(
  face: { x: number; y: number },
  pointer: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: Math.tanh((pointer.x - face.x) / 148),
    y: Math.tanh((pointer.y - face.y) / 112)
  };
}

export const POINTER_FRESH_MS = 880;

export function resolveEyePose(input: {
  mood: LivingFaceMood;
  nowMs: number;
  pointer: { x: number; y: number; atMs: number } | null;
  faceCenter: { x: number; y: number };
  idle: { x: number; y: number };
}): { lookX: number; lookY: number; expression: LivingFaceExpression } {
  const expression = expressionForMood(input.mood);
  if (input.mood === 'tool') {
    return { lookX: 0, lookY: 0, expression };
  }
  if (input.mood === 'thinking') {
    return { lookX: 0.12, lookY: -0.18, expression };
  }
  const fresh =
    input.pointer !== null && input.nowMs - input.pointer.atMs <= POINTER_FRESH_MS;
  if (fresh && input.pointer) {
    const gaze = faceGaze(input.faceCenter, input.pointer);
    return { lookX: gaze.x, lookY: gaze.y, expression };
  }
  return { lookX: input.idle.x, lookY: input.idle.y, expression };
}

/** Horizontal scan used while a tool is running. phase is 0…1. */
export function toolScan(phase: number): number {
  const x = wrap01(phase);
  const tri = x < 0.5 ? x * 2 : 2 - x * 2;
  return (tri * 2 - 1) * 0.72;
}

/** Mouth opening while speaking. 0 closed, 1 wide. phase is 0…1. */
export function speakingMouth(phase: number): number {
  const x = wrap01(phase);
  if (x < 0.18) return x / 0.18;
  if (x < 0.36) return 1 - (x - 0.18) / 0.18;
  if (x < 0.5) return ((x - 0.36) / 0.14) * 0.65;
  if (x < 0.64) return 0.65 * (1 - (x - 0.5) / 0.14);
  return 0.08;
}

/** Thinking-mark dot scale. Dots pulse out of step with each other. */
export function ellipsisScale(index: number, phase: number): number {
  const wave = Math.sin((wrap01(phase) + index * 0.18) * Math.PI * 2);
  return 0.55 + 0.45 * ((wave + 1) / 2);
}

export const SLEEPY_AFTER_MS = 4200;
export const HAPPY_BEAT_MS = 880;
export const HOVER_HOP_MS = 420;

export type FaceGesture = 'rest' | 'sleepy' | 'hover' | 'happy' | 'ellipsis' | 'talk' | 'surprised';

/**
 * Decorative motion layered on an idle face.
 * A live turn keeps its expression. After it returns to idle, a short happy
 * beat wins, then hover, then a sleepy face once the pointer has been gone.
 */
export function resolveFaceGesture(input: {
  mood: LivingFaceMood;
  hovering: boolean;
  pointerAgeMs: number | null;
  nowMs: number;
  happyUntilMs: number | null;
}): FaceGesture {
  const base = expressionForMood(input.mood);
  if (base === 'ellipsis' || base === 'talk' || base === 'surprised') return base;
  if (input.happyUntilMs !== null && input.nowMs < input.happyUntilMs) return 'happy';
  if (input.hovering) return 'hover';
  if (input.pointerAgeMs !== null && input.pointerAgeMs > SLEEPY_AFTER_MS) return 'sleepy';
  return 'rest';
}

/** When a live turn becomes idle, the face celebrates until this timestamp. */
export function turnFinishHappyUntil(
  prev: LivingFaceMood,
  next: LivingFaceMood,
  nowMs: number
): number | null {
  if (prev !== 'idle' && next === 'idle') return nowMs + HAPPY_BEAT_MS;
  return null;
}

/** One small hop when the pointer arrives, then a held smile. */
export function hoverDelight(elapsedMs: number): { dy: number; smile: number } {
  if (elapsedMs < 0) return { dy: 0, smile: 0 };
  if (elapsedMs >= HOVER_HOP_MS) return { dy: 0, smile: 1 };
  const p = elapsedMs / HOVER_HOP_MS;
  return { dy: -Math.sin(p * Math.PI) * 1.1, smile: 1 };
}

/** Two softening hops after a turn ends. `dy` is up when negative. */
export function happyBeat(elapsedMs: number): { dy: number; smile: number } {
  if (elapsedMs < 0 || elapsedMs > HAPPY_BEAT_MS) return { dy: 0, smile: 0 };
  const p = elapsedMs / HAPPY_BEAT_MS;
  const hop = Math.sin(p * Math.PI * 2) * (1 - p);
  return { dy: -1.2 * hop, smile: 1 };
}

/** Slow vertical breath while sleepy. */
export function sleepyBreath(phase: number): number {
  return Math.sin(wrap01(phase) * Math.PI * 2) * 0.8;
}

/** Mouth outline in the 64 viewBox. `openAmount` is 0…1 while speaking. */
export function mouthPath(kind: MouthKind, y: number, openAmount = 0): string {
  switch (kind) {
    case 'rest':
      return `M28 ${y} Q32 ${y + 2.6} 36 ${y}`;
    case 'smile':
      return `M29 ${y} Q32 ${y + 2.2} 35 ${y}`;
    case 'oh':
      return `M${29} ${y - 2.2} a3 3.2 0 1 0 6 0 a3 3.2 0 1 0 -6 0`;
    case 'sleepy':
      return `M29 ${y + 1} H35`;
    case 'open': {
      const drop = 2.4 + clamp01(openAmount) * 4;
      return `M27 ${y} Q32 ${y + drop} 37 ${y}`;
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export function mouthKindForGesture(gesture: FaceGesture): MouthKind {
  switch (gesture) {
    case 'rest':
    case 'ellipsis':
      return 'rest';
    case 'hover':
    case 'happy':
      return 'smile';
    case 'sleepy':
      return 'sleepy';
    case 'talk':
      return 'open';
    case 'surprised':
      return 'oh';
    default: {
      const unreachable: never = gesture;
      return unreachable;
    }
  }
}

export function damp(current: number, target: number, dtMs: number): number {
  if (dtMs <= 0) return current;
  const t = 1 - Math.exp(-dtMs / 90);
  return current + (target - current) * t;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function wrap01(phase: number): number {
  const x = phase % 1;
  return x < 0 ? x + 1 : x;
}

/** Mouth motion follows the clock even when no stream tokens arrive. */
export function talkingMouthAmount(gesture: string, reduced: boolean, now: number): number {
  if (gesture !== 'talk') return 0;
  return reduced ? 0.45 : speakingMouth((now % 520) / 520);
}

/** Open mouths are filled; smiles and resting mouths use an outline. */
export function mouthFilled(kind: MouthKind): boolean {
  return kind === 'open' || kind === 'oh';
}
