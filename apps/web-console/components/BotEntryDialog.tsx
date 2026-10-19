'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { activateEntryDialogCancel, shouldDismissEntryDialog } from '@/lib/entry-dialog';
import { dialogTabTarget } from '@/lib/entry-navigation';
import './BotEntryDialog.css';

/** A focused create flow that keeps its underlying conversation mounted. */
export function BotEntryDialog({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    if (!panel?.contains(document.activeElement)) focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        activateEntryDialogCancel(panel);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const target = dialogTabTarget(items, document.activeElement as HTMLElement, Boolean(panel?.contains(document.activeElement)), event.shiftKey);
      if (!items.length || target) { event.preventDefault(); target?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); (before?.isConnected ? before : document.getElementById('btnPlayCreate'))?.focus(); };
  }, []);
  return (
    <div
      className="bot-entry-backdrop"
      onMouseDown={(event) => {
        pressedBackdrop.current = shouldDismissEntryDialog(true, event.target, event.currentTarget);
      }}
      onClick={(event) => {
        if (shouldDismissEntryDialog(pressedBackdrop.current, event.target, event.currentTarget)) activateEntryDialogCancel(ref.current);
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="bot-entry-dialog">{children}</div>
    </div>
  );
}
