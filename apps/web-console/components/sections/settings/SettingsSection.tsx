'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SUB_PAGES } from '@/lib/nav';
import { filterSettingsEntries } from '@/lib/settings-search';
import { AdvancedToggle, EmptyState, Section, useAdvancedMode } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import { useSectionNav } from '../../shell/useSectionNav';
import { ModelOnboardingBanner } from '../../ModelOnboardingBanner';
import { OpsWorkspace } from '../ops/OpsSection';
import { SETTINGS_ENTRIES, type SettingsCategoryId } from './registry';
import './settings.css';

export function SettingsSection({ active }: { active: boolean }) {
  const { t } = useI18n();
  const { selectedSessionId, location, navigate } = useLab();
  const { sub, select } = useSectionNav('settings');
  const [advanced] = useAdvancedMode();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!searchRef.current || searchRef.current.offsetParent === null) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const searchable = useMemo(
    () =>
      SETTINGS_ENTRIES.map((entry) => ({
        entry,
        id: entry.id,
        advanced: entry.advanced,
        title: t(entry.titleKey),
        haystack: [
          t(entry.titleKey),
          entry.keywordsKey ? t(entry.keywordsKey) : '',
          t(`settings.categories.${entry.category}` as MessageKey),
          entry.id
        ].join(' ')
      })),
    [t]
  );

  const searching = query.trim().length > 0;
  const category = (sub ?? SUB_PAGES.settings[0]) as SettingsCategoryId;
  const showOps = !searching && category === 'ops';

  const visible = useMemo(() => {
    const matched = filterSettingsEntries(searchable, query, advanced);
    return searching ? matched : matched.filter((m) => m.entry.category === category);
  }, [searchable, query, advanced, searching, category]);

  if (!active) return null;

  const categoryLabel = (id: SettingsCategoryId) => t(`settings.categories.${id}` as MessageKey);

  return (
    <div className="lab-page">
      <Section
        id="section-settings"
        title={t('shell.nav.settings')}
        description={t('shell.desc.settings')}
        actions={<AdvancedToggle />}
      >
        <ModelOnboardingBanner hideCta={!searching && category === 'models'} />
        <div className="settings-search">
          <input
            ref={searchRef}
            type="search"
            id="settingsSearch"
            value={query}
            placeholder={t('settings.searchPlaceholder')}
            aria-label={t('settings.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
          {searching ? (
            <>
              <span className="settings-search__count" data-testid="settings-search-count" aria-live="polite">
                {t('settings.searchCount', { count: visible.length })}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('settings.searchClear')}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                ×
              </button>
            </>
          ) : (
            <kbd className="settings-search__hint" aria-hidden="true">/</kbd>
          )}
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('settings.categoriesLabel')}>
            {SUB_PAGES.settings.map((id) => (
              <button
                key={id}
                type="button"
                id={`settings-cat-${id}`}
                className={`settings-nav__item${!searching && id === category ? ' is-active' : ''}`}
                aria-current={!searching && id === category ? 'page' : undefined}
                onClick={() => {
                  setQuery('');
                  if (id === 'ops' && category === 'ops') return;
                  select(id);
                }}
              >
                {categoryLabel(id)}
              </button>
            ))}
          </nav>
          <div className="settings-entries" id={`section-settings-${searching ? 'search' : category}`}>
            {showOps ? (
              <OpsWorkspace
                pane={location.pane}
                onSelectPane={(pane) => navigate('settings', 'ops', pane)}
              />
            ) : visible.length === 0 ? (
              <EmptyState
                title={searching ? t('settings.noResultsTitle') : t('settings.emptyCategoryTitle')}
                description={searching ? t('settings.noResultsDesc', { query: query.trim() }) : t('settings.emptyCategoryDesc')}
              />
            ) : (
              visible.map(({ entry }) => (
                <div key={entry.id} id={`setting-${entry.id}`} className="settings-entry">
                  {searching ? (
                    <span className="settings-entry__tag">
                      {categoryLabel(entry.category)}
                      {entry.advanced ? ` · ${t('shell.ui.advanced')}` : ''}
                    </span>
                  ) : null}
                  {entry.render({ sessionId: selectedSessionId ?? undefined })}
                </div>
              ))
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
