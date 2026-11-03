'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SKIN_CHANGED_EVENT, SKIN_IDS, SKIN_MENU_OPEN_ATTR, applySkin, readSkin, type SkinId } from '@/lib/skin';

export function SkinToggle() {
  const { t } = useI18n();
  const [skin, setSkin] = useState<SkinId>('classic');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
      if (skinPressInside(rootRef.current, listRef.current, event.target)) return;
      setOpen(false);
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

  useEffect(() => {
    const root = document.documentElement;
    if (open) root.setAttribute(SKIN_MENU_OPEN_ATTR, '1');
    else root.removeAttribute(SKIN_MENU_OPEN_ATTR);
    return () => root.removeAttribute(SKIN_MENU_OPEN_ATTR);
  }, [open]);

  const label = t('settings.skin.label');
  const pick = (id: SkinId) => {
    applySkin(id);
    setOpen(false);
  };
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
      {open && box ? renderSkinList({ label, box, skin, listRef, onPick: pick, t }) : null}
    </div>
  );
}

function skinMenuMount(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.body ?? document.documentElement;
}

function eventNode(target: EventTarget | null): Node | null {
  if (target && typeof (target as Node).nodeType === 'number') return target as Node;
  return null;
}

function listedSkinOption(node: Node): boolean {
  if (typeof Element === 'undefined') return false;
  if (!(node instanceof Element)) return false;
  return Boolean(node.closest('.skin-menu__list'));
}

function skinPressInside(root: Node | null, list: Node | null, target: EventTarget | null): boolean {
  const node = eventNode(target);
  if (!node) return false;
  if (root?.contains(node)) return true;
  if (list?.contains(node)) return true;
  return listedSkinOption(node);
}

function keepSkinListPress(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

function renderSkinList(args: {
  label: string;
  box: { top: number; left: number };
  skin: SkinId;
  listRef: RefObject<HTMLUListElement | null>;
  onPick: (id: SkinId) => void;
  t: (key: MessageKey) => string;
}) {
  const host = skinMenuMount();
  if (!host) return null;
  return createPortal(
    <ul
      ref={args.listRef}
      className="skin-menu__list"
      role="listbox"
      aria-label={args.label}
      style={{ top: args.box.top, left: args.box.left }}
      onMouseDown={keepSkinListPress}
    >
      {SKIN_IDS.map((id) => (
        <li key={id}>
          <button
            type="button"
            role="option"
            aria-selected={args.skin === id}
            className={optionClass(args.skin, id)}
            onClick={() => args.onPick(id)}
          >
            {args.t(`settings.skin.${id}` as MessageKey)}
          </button>
        </li>
      ))}
    </ul>,
    host
  );
}

function optionClass(skin: SkinId, id: SkinId): string | undefined {
  if (skin === id) return 'is-on';
  return undefined;
}

function SealIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5 9.1 7.2 12 7.4 9.8 9.1 10.5 12 8 10.5 5.5 12 6.2 9.1 4 7.4 6.9 7.2Z" />
    </svg>
  );
}
