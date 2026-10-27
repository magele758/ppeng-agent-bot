'use client';

import { createElement, useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { readBriefOpen, writeBriefOpen } from '../lib/session-brief.ts';

/** Closed unless this note was opened before. Click again to fold it. */
export function SessionBriefDisclosure({
  noteKey,
  label,
  title,
  children
}: {
  noteKey?: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => (noteKey ? readBriefOpen(noteKey) : false));
  useEffect(() => {
    if (!noteKey) return;
    setOpen(readBriefOpen(noteKey));
  }, [noteKey]);
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (noteKey) writeBriefOpen(noteKey, next);
  };
  return createElement(
    'details',
    { className: 'chat-process-note', open, onToggle: toggle },
    createElement('summary', { title }, label),
    createElement('div', { className: 'chat-process-note__body' }, children)
  );
}
