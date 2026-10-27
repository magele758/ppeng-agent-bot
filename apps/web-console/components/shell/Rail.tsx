'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { SECTION_IDS, formatHash, type SectionId } from '@/lib/nav';
import { readRailCollapsed, writeRailCollapsed } from '@/lib/rail-collapsed';
import { SectionIcon } from './icons';
import { useLab } from './LabProvider';

const FOOT_MENU_CLOSE_MS = 160;

type FootBox = { bottom: number; left: number; width: number };

function readFootBox(node: HTMLElement | null): FootBox | null {
  if (!node || typeof node.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return {
    bottom: Math.max(0, window.innerHeight - rect.top - 4),
    left: rect.left,
    width: rect.width < 160 ? 196 : rect.width
  };
}

function RailToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
    </svg>
  );
}

function useRailFoot(children: ReactNode) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [box, setBox] = useState<FootBox | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const scheduleCloseRef = useRef<(event?: { relatedTarget?: EventTarget | null }) => void>(() => {});
  const clearCloseRef = useRef<() => void>(() => {});
  const pointerInsideRef = useRef<(next: EventTarget | null) => boolean>(() => false);
  const open = hovered || focused;

  const clearClose = () => {
    if (closeTimer.current == null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const place = () => {
    const next = readFootBox(rootRef.current);
    if (next) setBox(next);
  };

  const pointerStillInside = (next: EventTarget | null) => {
    if (!next || typeof (next as Node).nodeType !== 'number') return false;
    const node = next as Node;
    return Boolean(rootRef.current?.contains(node) || menuRef.current?.contains(node));
  };

  const arm = () => {
    clearClose();
    setHovered(true);
    place();
  };

  const armFocus = () => {
    setFocused(true);
    place();
  };

  const scheduleClose = (event?: { relatedTarget?: EventTarget | null }) => {
    if (pointerStillInside(event?.relatedTarget ?? null)) return;
    clearClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!alive.current) return;
      setHovered(false);
    }, FOOT_MENU_CLOSE_MS);
  };
  scheduleCloseRef.current = scheduleClose;
  clearCloseRef.current = clearClose;
  pointerInsideRef.current = pointerStillInside;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (closeTimer.current != null) clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const update = () => {
      const next = readFootBox(rootRef.current);
      if (next) setBox(next);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onMove = (event: MouseEvent) => {
      const target = event.target;
      if (target && pointerInsideRef.current(target)) {
        clearCloseRef.current();
        return;
      }
      scheduleCloseRef.current();
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [open]);

  if (!children) return null;

  return (
    <div
      className="lab-rail__foot"
      ref={rootRef}
      onMouseEnter={arm}
      onMouseLeave={scheduleClose}
      onFocus={armFocus}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && (event.currentTarget.contains(next as Node) || menuRef.current?.contains(next as Node))) return;
        setFocused(false);
      }}
    >
      <button
        type="button"
        className="lab-rail__foot-trigger"
        data-testid="rail-foot-trigger"
        aria-label={t('shell.nav.footMenu')}
        title={t('shell.nav.footMenu')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="lab-rail-foot-menu"
        onFocus={armFocus}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      <div
        id="lab-rail-foot-menu"
        ref={menuRef}
        className="lab-rail__foot-menu"
        role="group"
        aria-label={t('shell.nav.footMenu')}
        hidden={!open}
        onMouseEnter={arm}
        onMouseLeave={scheduleClose}
        onFocus={armFocus}
        style={box ? { position: 'fixed', right: 'auto', bottom: box.bottom, left: box.left, width: box.width } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export function Rail({ footer }: { footer?: ReactNode | ((collapsed: boolean) => ReactNode) }) {
  const { t } = useI18n();
  const { location, navigate, approvals } = useLab();
  const [collapsed, setCollapsed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (toolsOpen) dialogRef.current?.showModal();
  }, [toolsOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const close = () => { if (!media.matches) { dialogRef.current?.close(); setToolsOpen(false); } };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);

  useEffect(() => {
    setCollapsed(readRailCollapsed());
  }, []);

  const toggleLabel = collapsed ? t('shell.nav.expand') : t('shell.nav.collapse');

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeRailCollapsed(next);
      return next;
    });
  };

  const badgeFor = (id: SectionId): number => (id === 'tasks' ? approvals.length : 0);
  const foot = footer != null && !toolsOpen ? (typeof footer === 'function' ? footer(false) : footer) : null;
  const footNode = useRailFoot(foot);

  return (
    <aside className={collapsed ? 'lab-rail is-collapsed' : 'lab-rail'} aria-label={t('shell.nav.label')}>
      <div className="lab-rail__top">
        <div className="lab-rail__brand">
          <span className="brand-mark" aria-hidden="true">
            <svg className="brand-glyph" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 24V8l8 8 8-8v16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="16" cy="16" r="3" fill="currentColor" />
            </svg>
          </span>
          <span className="lab-rail__brand-name">{t('nav.agentHome')}</span>
        </div>
        <button
          type="button"
          id="nav-rail-toggle"
          className="lab-rail__toggle"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle}
        >
          <RailToggleIcon collapsed={collapsed} />
        </button>
      </div>
      <nav className="lab-rail__nav" id="lab-rail-nav" aria-label={t('shell.nav.primary')}>
        {SECTION_IDS.map((id) => {
          const badge = badgeFor(id);
          const current = location.section === id;
          const label = t(`shell.nav.${id}`);
          return (
            <a
              key={id}
              id={`nav-${id}`}
              className="lab-rail__link"
              href={formatHash({ section: id, sub: null })}
              title={label}
              aria-current={current ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(id);
              }}
            >
              <span className="lab-rail__icon">
                <SectionIcon id={id} />
              </span>
              <span className="lab-rail__label">{label}</span>
              {badge > 0 ? (
                <span className="lab-rail__badge" aria-label={t('shell.nav.pending', { count: badge })}>
                  {badge}
                </span>
              ) : null}
            </a>
          );
        })}
      </nav>
      {footNode}
      <button type="button" className="mobile-tools-toggle btn btn-ghost" data-testid="mobile-tools-toggle" aria-label={t('mobile.tools')} aria-haspopup="dialog" onClick={() => setToolsOpen(true)}>•••</button>
      {toolsOpen ? <dialog ref={dialogRef} className="mobile-tools-dialog" aria-labelledby="mobile-tools-title" onClose={() => setToolsOpen(false)} onClick={e => { if (e.target === e.currentTarget) dialogRef.current?.close(); }}>
        <div className="mobile-tools-dialog__body">
          <header><h2 id="mobile-tools-title">{t('mobile.tools')}</h2><button type="button" className="btn btn-ghost" onClick={() => dialogRef.current?.close()}>{t('mobile.close')}</button></header>
          <div className="mobile-tools-dialog__actions" onClick={e => { if ((e.target as HTMLElement).closest('#btnModelSetup')) dialogRef.current?.close(); }}>{typeof footer === 'function' ? footer(false) : footer}</div>
        </div>
      </dialog> : null}
    </aside>
  );
}
