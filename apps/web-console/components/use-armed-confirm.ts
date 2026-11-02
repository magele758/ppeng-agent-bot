'use client';

import { useEffect, useState } from 'react';

import { armedDeleteAction } from '../lib/armed-delete';

/** First click arms, the next click runs, Esc or an outside press or 4s disarms. */
export function useArmedConfirm() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArmed(false);
    };
    const onPointer = () => setArmed(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [armed]);
  return {
    armed,
    onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onClick: (event: { stopPropagation: () => void }, run: () => void) => {
      event.stopPropagation();
      if (armedDeleteAction(armed) === 'arm') {
        setArmed(true);
        return;
      }
      setArmed(false);
      run();
    }
  };
}
