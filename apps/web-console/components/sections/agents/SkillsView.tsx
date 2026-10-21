'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSkillBots } from '../../BotSkillSharing';
import { api } from '@/lib/api';
import { SKILL_SOURCES, filterSkills, type SkillItem } from '@/lib/agents-view';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { EmptyState } from '../../ui';
import { NoMatch } from './NoMatch';
import { SearchBox } from './SearchBox';

const SOURCE_LABEL: Record<SkillItem['source'], MessageKey> = {
  builtin: 'agents.skills.sourceBuiltin',
  workspace: 'agents.skills.sourceWorkspace',
  agents: 'agents.skills.sourceAgents',
  user: 'agents.skills.sourceUser'
};

export function SkillsView() {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SkillItem['source'] | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await api('/api/skills')) as { skills?: SkillItem[] };
      setSkills(res.skills ?? []);
    } catch (e) {
      setError(t('agents.common.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => filterSkills(skills, query, source), [skills, query, source]);
  const clear = () => {
    setQuery('');
    setSource('all');
  };

  return (
    <div className="ag-block" id="skillsView">
      <div className="ag-toolbar">
        <div className="ag-toolbar__grow">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t('agents.skills.searchPh')}
            ariaLabel={t('agents.skills.searchAria')}
          />
        </div>
        <select
          className="ag-select"
          value={source}
          aria-label={t('agents.skills.sourceAria')}
          onChange={(e) => setSource(e.target.value as SkillItem['source'] | 'all')}
        >
          <option value="all">{t('agents.skills.sourceAll')}</option>
          {SKILL_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(SOURCE_LABEL[s])}
            </option>
          ))}
        </select>
        <span className="ag-toolbar__meta">{t('agents.common.count', { count: visible.length })}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          {t('agents.skills.reload')}
        </button>
      </div>
      {loading && skills.length === 0 ? (
        <p className="ag-panel__lead">{t('common.loading')}</p>
      ) : error ? (
        <p className="ag-status ag-status--err" role="alert">
          {error}
        </p>
      ) : skills.length === 0 ? (
        <EmptyState title={t('agents.skills.emptyTitle')} description={t('agents.skills.emptyDesc')} />
      ) : visible.length === 0 ? (
        <NoMatch onClear={clear} />
      ) : (
        <div className="ag-grid" role="list">
          {visible.map((s) => (
            <article key={s.id} className="ag-card" role="listitem" data-testid={`skill-card-${s.id}`} style={{ cursor: 'default' }}>
              <span className="ag-card__title">{s.name}</span>
              <span className="ag-chips">
                <span className="chip chip-muted">{t(SOURCE_LABEL[s.source])}</span>
              </span>
              {s.ownerBotId ? <span className="ag-card__sub">{t('skillProposals.ownerBot', { name: bots.find(b => b.id === s.ownerBotId)?.name ?? s.ownerBotId })}</span> : s.source === 'user' ? <span className="ag-card__sub">{t('skillProposals.legacyShared')}</span> : null}
              <p className="ag-card__desc">{s.description}</p>
              {s.triggerWords?.length ? (
                <span className="ag-card__sub">{t('agents.skills.triggers', { words: s.triggerWords.join(', ') })}</span>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
