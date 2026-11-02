'use client';

import { useLayoutEffect, useRef } from 'react';
import {
  createComposerDraftScope,
  type ComposerDraftIo,
  type ComposerDraftSpot
} from '@/lib/composer-draft';

/** Swap the composer draft whenever the conversation changes, before the new one paints. */
export function useComposerDraftScope(spot: ComposerDraftSpot, claimed: boolean, io: ComposerDraftIo) {
  const scopeRef = useRef<ReturnType<typeof createComposerDraftScope> | null>(null);
  scopeRef.current ??= createComposerDraftScope(spot);
  const live = useRef({ spot, claimed, io });
  live.current = { spot, claimed, io };

  useLayoutEffect(() => {
    const now = live.current;
    scopeRef.current?.move(now.spot, { claimed: now.claimed }, now.io);
  }, [spot.key]);
}
