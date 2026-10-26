'use client';

import { useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { memberDrawer, type FunctionalGroupRef, type RoomBot } from './room-console';

export function RoomMemberDrawer({
  memberIds,
  bots,
  groups,
  hostId,
  speakingIds,
  busy,
  error,
  onClose,
  onAddMember,
  onRemoveMember,
  onAddGroup,
  onRemoveGroup
}: {
  memberIds: readonly string[];
  bots: readonly BotInfo[];
  groups: readonly FunctionalGroupRef[];
  hostId: string;
  speakingIds: readonly string[];
  busy: boolean;
  error: string;
  onClose?: () => void;
  onAddMember: (botId: string) => void;
  onRemoveMember: (botId: string) => void;
  onAddGroup: (groupId: string) => void;
  onRemoveGroup: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [addId, setAddId] = useState('');
  const roster: RoomBot[] = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description
  }));
  const view = memberDrawer({
    memberIds,
    bots: roster,
    groups,
    hostId,
    speakingIds,
    query,
    ungroupedLabel: t('play.group.ungrouped')
  });
  const inside = new Set(memberIds);
  const available = bots.filter((bot) => !inside.has(bot.id));
  const hostName = view.host?.name ?? hostId;
  const speakingNames = view.speaking.map((member) => member.name).join(t('play.group.nameSeparator'));

  return (
    <section className="play-group-drawer" data-testid="play-group-member-drawer" aria-label={t('play.group.membersDrawer')}>
      <div className="play-group-drawer__bar">
        <p data-testid="play-group-host">{t('play.group.hostLine', { name: hostName })}</p>
        {speakingNames ? <p data-testid="play-group-drawer-speaking">{t('play.group.speakingNow', { names: speakingNames })}</p> : null}
        {onClose ? <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('play.group.closeMembers')}</button> : null}
      </div>
      <input
        data-testid="play-group-member-search"
        aria-label={t('play.group.membersSearch')}
        placeholder={t('play.group.membersSearchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {view.sections.map((section) => (
        <div key={section.id} className="play-group-drawer__section" data-testid="play-group-member-section">
          <div className="play-group-drawer__section-bar">
            <h3>{section.name}</h3>
            {section.id !== 'ungrouped' ? (
              <div className="play-group-drawer__section-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid={`play-group-add-group-${section.id}`}
                  disabled={busy || !section.canAdd}
                  aria-label={t('play.group.addGroupAria', { name: section.name })}
                  onClick={() => onAddGroup(section.id)}
                >
                  {t('play.group.addGroup')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid={`play-group-remove-group-${section.id}`}
                  disabled={busy || !section.canRemove}
                  title={section.removeBlocked ? t('play.group.keepTwo') : undefined}
                  aria-label={t('play.group.removeGroupAria', { name: section.name })}
                  onClick={() => onRemoveGroup(section.id)}
                >
                  {t('play.group.removeGroup')}
                </button>
              </div>
            ) : null}
          </div>
          <ul className="play-group-drawer__members">
            {section.members.map((member) => (
              <li key={member.id}>
                <span>{member.name}</span>
                {member.host ? <span className="play-group-badge">{t('play.group.hostBadge')}</span> : null}
                {member.speaking ? <span className="play-group-badge">{t('play.group.speakingBadge')}</span> : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || memberIds.length <= 2}
                  aria-label={t('play.group.removeAria', { name: member.name })}
                  onClick={() => onRemoveMember(member.id)}
                >
                  {t('play.group.remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="play-group-add">
        <select aria-label={t('play.group.addMember')} value={addId} onChange={(event) => setAddId(event.target.value)}>
          <option value="">{t('play.group.addMember')}</option>
          {available.map((bot) => (
            <option key={bot.id} value={bot.id}>{bot.name}</option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !addId} onClick={() => { onAddMember(addId); setAddId(''); }}>
          {t('play.group.add')}
        </button>
      </div>
      {memberIds.length <= 2 ? <p className="play-group-hint">{t('play.group.keepTwo')}</p> : null}
      {error ? <p className="play-group-error">{error}</p> : null}
    </section>
  );
}
