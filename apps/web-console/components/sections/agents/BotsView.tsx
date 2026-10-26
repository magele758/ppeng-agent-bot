'use client';
import '../../bot-work/bot-work.css';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { readBotGroupCreate, readBotPermissionsTarget } from '@/lib/bot-chat-header';
import { readBotConnectionsTarget } from '@/lib/bot-recovery-link';
import { filterBots } from '@/lib/agents-view';
import { applyBotsHash, botCardSelected, botCardSubtitle, botsPane, showBotsEmpty, visibleBotRoster } from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotFace } from '../../BotFace';
import { EmptyState } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import { BotCreateForm } from './BotCreateForm';
import { BotGroupCreateForm } from './BotGroupCreateForm';
import { BotDetail } from './BotDetail';
import { NoMatch } from './NoMatch';
import { SearchBox } from './SearchBox';

export function BotsView() {
  const { t } = useI18n();
  const lab = useLab();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; err: boolean } | null>(null);

  useEffect(() => { let active=true; void api('/api/bot-work/default').then(data=>{if(active)lab.upsertBot((data as {bot:BotInfo}).bot);}).catch(e=>setNotice({text:String(e),err:true}));return()=>{active=false;}; }, []);

  useEffect(() => {
    const apply = () => {
      applyBotsHash(window.location.hash, readBotGroupCreate, hash => readBotPermissionsTarget(hash) ?? readBotConnectionsTarget(hash), {
        setCreating,
        setCreatingGroup,
        setNotice,
        setQuery,
        setSelectedId
      });
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
    setCreatingGroup(false);
    setQuery('');
    setNotice({ text: t('agents.bots.created', { name: bot.name }), err: false });
  };

  const startCreate = () => {
    setCreating(true);
    setCreatingGroup(false);
    setNotice(null);
  };

  const pane = botsPane(creating, creatingGroup, selected !== null);
  const paneOpen = pane === 'create' || pane === 'group';
  const rightPane = pane === 'none' ? null : (
    <BotsRightPane
      pane={pane}
      roster={roster}
      selected={selected}
      onCreated={created}
      onCancelCreate={() => setCreating(false)}
      onGroupCreated={(title) => {
        setCreatingGroup(false);
        setNotice({ text: t('agents.bots.groupCreated', { name: title }), err: false });
      }}
      onCancelGroup={() => setCreatingGroup(false)}
      onOpenChat={(bot) => void openChat(bot)}
    />
  );

  // Creation has its own focused surface; the management list returns on cancel.
  if (paneOpen) {
    return <div className="ag-block ag-bot-create-surface" id="botsView">{rightPane}</div>;
  }

  if (showBotsEmpty(roster.length, pane)) {
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
        <button type="button" className="btn btn-primary btn-sm" data-testid="bot-create-open" onClick={startCreate} disabled={creating}>
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
              <BotRosterCard
                key={b.id}
                bot={b}
                selected={botCardSelected(b.id, selectedId, paneOpen)}
                agentLabel={t('agents.bots.agentChip', { agent: b.agentId })}
                onOpen={() => {
                  setSelectedId(b.id);
                  setCreating(false);
                  setCreatingGroup(false);
                  setNotice(null);
                }}
              />
            ))}
          </div>
        )}
        {rightPane}
      </div>
    </div>
  );
}

function BotsRightPane({
  pane,
  roster,
  selected,
  onCreated,
  onCancelCreate,
  onGroupCreated,
  onCancelGroup,
  onOpenChat
}: {
  pane: ReturnType<typeof botsPane>;
  roster: readonly BotInfo[];
  selected: BotInfo | null;
  onCreated: (bot: BotInfo) => void;
  onCancelCreate: () => void;
  onGroupCreated: (title: string) => void;
  onCancelGroup: () => void;
  onOpenChat: (bot: BotInfo) => void;
}) {
  if (pane === 'create') {
    return <BotCreateForm existingNames={roster.map((bot) => bot.name)} onCreated={onCreated} onCancel={onCancelCreate} />;
  }
  if (pane === 'group') {
    return <BotGroupCreateForm bots={roster} onCreated={onGroupCreated} onCancel={onCancelGroup} />;
  }
  if (pane === 'detail' && selected) {
    return <BotDetail key={selected.id} bot={selected} onOpenChat={onOpenChat} />;
  }
  return null;
}

function BotRosterCard({
  bot,
  selected,
  agentLabel,
  onOpen
}: {
  bot: BotInfo;
  selected: boolean;
  agentLabel: string;
  onOpen: () => void;
}) {
  const subtitle = botCardSubtitle(bot.name, bot.title);
  return (
    <button
      type="button"
      role="listitem"
      className={`ag-card${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      data-testid={`bot-card-${bot.id}`}
      onClick={onOpen}
    >
      <span className="ag-card__identity">
        <BotFace name={bot.name} botId={bot.id} testId={`bot-face-${bot.id}`} />
        <span className="ag-card__title">{bot.name}</span>
      </span>
      {subtitle ? <span className="ag-card__sub">{subtitle}</span> : null}
      {bot.description ? <p className="ag-card__desc">{bot.description}</p> : null}
      <span className="ag-chips">
        <span className="chip chip-muted">{agentLabel}</span>
      </span>
    </button>
  );
}
