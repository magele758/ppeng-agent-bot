'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SKIN_CHANGED_EVENT, SKIN_IDS, applySkin, readSkin, type SkinId } from '@/lib/skin';

export function SkinToggle() {
  const { t } = useI18n();
  const [skin, setSkin] = useState<SkinId>('classic');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const sync = () => setSkin(readSkin());
    sync();
    setMounted(true);
    window.addEventListener(SKIN_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SKIN_CHANGED_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = t('settings.skin.label');
  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = SKIN_IDS.length * 36 + 8;
      const top = rect.bottom + menuHeight > window.innerHeight ? Math.max(8, rect.bottom - menuHeight) : rect.top;
      setBox({ top, left: rect.right + 8 });
    }
    setOpen((value) => !value);
  };

  return (
    <div className="skin-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn-ghost btn-icon"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        disabled={!mounted}
        onClick={toggle}
      >
        <SealIcon />
      </button>
      {open && box ? (
        <ul className="skin-menu__list" role="listbox" aria-label={label} style={{ top: box.top, left: box.left }}>
          {SKIN_IDS.map((id) => (
            <li key={id}>
              <button
                type="button"
                role="option"
                aria-selected={skin === id}
                className={skin === id ? 'is-on' : undefined}
                onClick={() => {
                  applySkin(id);
                  setOpen(false);
                }}
              >
                {t(`settings.skin.${id}` as MessageKey)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SealIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5 9.1 7.2 12 7.4 9.8 9.1 10.5 12 8 10.5 5.5 12 6.2 9.1 4 7.4 6.9 7.2Z" />
    </svg>
  );
}
