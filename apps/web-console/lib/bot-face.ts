/**
 * Stable bot → face index.
 * Faces are original geometry in `BotFace`; this module only picks which one.
 * ASCII case is mixed in on purpose so "Ada" and "ada" are not forced onto one face.
 */

export const BOT_FACE_COUNT = 8;

const FACE_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export type BotFaceIndex = (typeof FACE_INDEXES)[number];

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
