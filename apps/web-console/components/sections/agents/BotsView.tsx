'use client';
import '../../bot-work/bot-work.css';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { readBotPermissionsTarget } from '@/lib/bot-chat-header';
import { BotLimits } from '../../bot-work/BotLimits';
import { BotTeamWork } from '../../bot-work/BotTeamWork';
import { BotRooms } from '../../bot-work/BotRooms';
import { filterBots } from '@/lib/agents-view';
import { visibleBotRoster } from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotFace } from '../../BotFace';
import { EmptyState } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import { BotCreateForm } from './BotCreateForm';
import { BotDetail } from './BotDetail';
import { NoMatch } from './NoMatch';
import { SearchBox } from './SearchBox';

export function BotsView() {
  const { t } = useI18n();
  const lab = useLab();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; err: boolean } | null>(null);

  useEffect(() => { let active=true; void api('/api/bot-work/default').then(data=>{if(active)lab.upsertBot((data as {bot:BotInfo}).bot);}).catch(e=>setNotice({text:String(e),err:true}));return()=>{active=false;}; }, []);

  useEffect(() => {
    const apply = () => {
      const target = readBotPermissionsTarget(window.location.hash);
      if (!target) return;
      setCreating(false);
      setQuery('');
      setSelectedId(target.botId);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const roster = useMemo(() => visibleBotRoster(lab.bots), [lab.bots]);
  const visible = useMemo(() => filterBots(roster, query), [roster, query]);
  const selected = roster.find((b) => b.id === selectedId) ?? null;

  const openChat = async (bot: BotInfo) => {
    try {
      const opened=await api(`/api/bots/${encodeURIComponent(bot.id)}/open`,{method:'POST'}) as {session:{id:string}};
      await lab.openSession(opened.session.id, { focusChat: true });
    } catch (e) {
      setNotice({ text: t('agents.bots.openChatFailed', { error: e instanceof Error ? e.message : String(e) }), err: true });
    }
  };

  const created = (bot: BotInfo) => {
    lab.upsertBot(bot);
    setSelectedId(bot.id);
    setCreating(false);
    setQuery('');
    setNotice({ text: t('agents.bots.created', { name: bot.name }), err: false });
  };

  const startCreate = () => {
    setCreating(true);
    setNotice(null);
  };

  const rightPane = creating ? (
    <BotCreateForm onCreated={created} onCancel={() => setCreating(false)} />
  ) : selected ? (
    <BotDetail key={selected.id} bot={selected} onOpenChat={(b) => void openChat(b)} />
  ) : null;

  if (roster.length === 0 && !creating) {
    return (
      <EmptyState
        icon={<BotFace name="" label={t('agents.bots.faceEmpty')} testId="bot-empty-face" size="lg" />}
        title={t('agents.bots.emptyTitle')}
        description={t('agents.bots.emptyDesc')}
        action={
          <button type="button" className="btn btn-primary" onClick={startCreate}>
            {t('agents.bots.newBot')}
          </button>
        }
      />
    );
  }

  return (
    <div className="ag-block" id="botsView">
      {!query.trim() && <>
      <BotLimits />
      <BotTeamWork bots={lab.bots} onOpen={bot=>void openChat(bot)} />
      <BotRooms bots={roster} />
      </>}
      <div className="ag-toolbar">
        <div className="ag-toolbar__grow">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t('agents.bots.searchPh')}
            ariaLabel={t('agents.bots.searchAria')}
          />
        </div>
        <span className="ag-toolbar__meta">{t('agents.common.count', { count: visible.length })}</span>
        <button type="button" className="btn btn-primary btn-sm" onClick={startCreate} disabled={creating}>
          {t('agents.bots.newBot')}
        </button>
      </div>
      {notice ? (
        <p className={`ag-status${notice.err ? ' ag-status--err' : ''}`} role="status">
          {notice.text}
        </p>
      ) : null}
      <div className={`ag-split${rightPane ? ' ag-split--detail' : ''}`}>
        {roster.length === 0 ? (
          <div />
        ) : visible.length === 0 ? (
          <NoMatch onClear={() => setQuery('')} />
        ) : (
          <div className="ag-grid" role="list">
            {visible.map((b) => (
              <button
                key={b.id}
                type="button"
                role="listitem"
                className={`ag-card${b.id === selectedId && !creating ? ' is-selected' : ''}`}
                aria-pressed={b.id === selectedId && !creating}
                data-testid={`bot-card-${b.id}`}
                onClick={() => {
                  setSelectedId(b.id);
                  setCreating(false);
                  setNotice(null);
                }}
              >
                <span className="ag-card__identity">
                  <BotFace name={b.name} testId={`bot-face-${b.id}`} />
                  <span className="ag-card__title">{b.name}</span>
                </span>
                {b.title && b.title !== b.name ? <span className="ag-card__sub">{b.title}</span> : null}
                {b.description ? <p className="ag-card__desc">{b.description}</p> : null}
                <span className="ag-chips">
                  <span className="chip chip-muted">{t('agents.bots.agentChip', { agent: b.agentId })}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {rightPane}
      </div>
    </div>
  );
}
