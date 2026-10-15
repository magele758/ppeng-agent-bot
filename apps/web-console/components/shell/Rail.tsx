'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { SECTION_IDS, formatHash, type SectionId } from '@/lib/nav';
import { readRailCollapsed, writeRailCollapsed } from '@/lib/rail-collapsed';
import { SectionIcon } from './icons';
import { useLab } from './LabProvider';

function RailToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
    </svg>
  );
}

export function Rail({ footer }: { footer?: ReactNode | ((collapsed: boolean) => ReactNode) }) {
  const { t } = useI18n();
  const { location, navigate, approvals } = useLab();
  const [collapsed, setCollapsed] = useState(false);

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
  const foot = typeof footer === 'function' ? footer(collapsed) : footer;

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
      {foot ? <div className="lab-rail__foot">{foot}</div> : null}
    </aside>
  );
}
