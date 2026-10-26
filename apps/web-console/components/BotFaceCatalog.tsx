'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { indexSavedFaces, type FaceCatalogBot, type SavedFaceEntry } from '@/lib/bot-face';

export type SavedFace = SavedFaceEntry;

const EMPTY: SavedFace = { shape: null, color: null, style: null, expression: null, avatar: null };

const CatalogContext = createContext<ReadonlyMap<string, SavedFace>>(new Map());

export function BotFaceCatalog({
  bots,
  children
}: {
  bots: readonly FaceCatalogBot[];
  children: ReactNode;
}) {
  const map = useMemo(() => indexSavedFaces(bots), [bots]);
  return <CatalogContext.Provider value={map}>{children}</CatalogContext.Provider>;
}

export function useSavedFace(name: string | null | undefined): SavedFace {
  const map = useContext(CatalogContext);
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return EMPTY;
  return map.get(key) ?? EMPTY;
}
