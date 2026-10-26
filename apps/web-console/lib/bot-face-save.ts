/**
 * Face edits from the bot detail. Clicks update a draft immediately.
 * Each save waits for the previous one, then reads the draft again,
 * so a slow style change cannot blank a silhouette picked while it waited.
 */

export type FaceDraft = {
  shape: string | null;
  color: string | null;
  style: string | null;
  softShape: string | null;
  softColor: string | null;
  softExpression: string | null;
};

export type FaceSaveKind = 'style' | 'shape' | 'color' | 'soft-shape' | 'soft-color' | 'soft-expression';

export type FacePatch = Record<string, string | null>;

/** The body for one click. A style click sends the whole set that is current now. */
export function facePatch(kind: FaceSaveKind, face: FaceDraft): FacePatch {
  if (kind === 'shape') return { faceShape: face.shape, faceStyle: 'classic' };
  if (kind === 'color') return { faceColor: face.color, faceStyle: 'classic' };
  if (kind === 'soft-shape') return { faceStyle: 'soft', faceShape: face.softShape };
  if (kind === 'soft-color') return { faceStyle: 'soft', faceColor: face.softColor };
  if (kind === 'soft-expression') return { faceStyle: 'soft', faceExpression: face.softExpression };
  return face.style === 'soft'
    ? { faceStyle: 'soft', faceShape: face.softShape, faceColor: face.softColor, faceExpression: face.softExpression }
    : { faceStyle: null, faceShape: face.shape, faceColor: face.color, faceExpression: null };
}

export function createFaceSaveQueue(read: () => FaceDraft): (kind: FaceSaveKind, send: (patch: () => FacePatch) => Promise<unknown>) => Promise<unknown> {
  let pending: Promise<unknown> = Promise.resolve();
  return (kind, send) => {
    const turn = pending.then(
      () => send(() => facePatch(kind, read())),
      () => send(() => facePatch(kind, read()))
    );
    pending = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  };
}
