'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** A focused create flow that keeps its underlying conversation mounted. */
export function BotEntryDialog({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    if (!panel?.contains(document.activeElement)) focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        // The last button is the form's cancel action. A disabled action keeps an in-flight submit open.
        const buttons = panel?.querySelectorAll<HTMLButtonElement>('button[type="button"]');
        buttons?.[buttons.length - 1]?.click();
      }
      if (event.key !== 'Tab') return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); (before?.isConnected ? before : document.getElementById('btnPlayCreate'))?.focus(); };
  }, []);
  return <div className="bot-entry-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="bot-entry-dialog">{children}</div></div>;
}
