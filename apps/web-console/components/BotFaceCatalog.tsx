'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { isBotFaceColor, isBotFaceShape, type BotFaceColor, type BotFaceShape } from '@/lib/bot-face';

export type SavedFace = { shape: BotFaceShape | null; color: BotFaceColor | null; avatar: string | null };

const EMPTY: SavedFace = { shape: null, color: null, avatar: null };

const CatalogContext = createContext<ReadonlyMap<string, SavedFace>>(new Map());

export function BotFaceCatalog({
  bots,
  children
}: {
  bots: readonly { name: string; faceShape?: string | null; faceColor?: string | null; avatar?: string | null }[];
  children: ReactNode;
}) {
  const map = useMemo(() => {
    const next = new Map<string, SavedFace>();
    for (const bot of bots) {
      const key = bot.name.trim();
      if (!key) continue;
      const shape = isBotFaceShape(bot.faceShape) ? bot.faceShape : null;
      const color = isBotFaceColor(bot.faceColor) ? bot.faceColor : null;
      const avatar = typeof bot.avatar === 'string' && bot.avatar.trim() ? bot.avatar.trim() : null;
      if (shape || color || avatar) next.set(key, { shape, color, avatar });
    }
    return next;
  }, [bots]);
  return <CatalogContext.Provider value={map}>{children}</CatalogContext.Provider>;
}

export function useSavedFace(name: string | null | undefined): SavedFace {
  const map = useContext(CatalogContext);
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return EMPTY;
  return map.get(key) ?? EMPTY;
}
