'use client';

import { useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { roomMemberModelLabel } from '@/lib/group-chat-view';
import type { RoomModelConfiguration } from '@/lib/room-models';
import { BotFace } from '../BotFace';
import { memberDrawer, type FunctionalGroupRef, type RoomBot } from './room-console';

export function RoomMemberDrawer({
  memberIds,
  bots,
  groups,
  hostId,
  speakingIds,
  models,
  faceMood = () => 'idle',
  busy,
  error,
  onClose,
  onAddMember,
  onRemoveMember,
  onAddGroup
}: {
  memberIds: readonly string[];
  bots: readonly BotInfo[];
  groups: readonly FunctionalGroupRef[];
  hostId: string;
  speakingIds: readonly string[];
  models: RoomModelConfiguration | null;
  faceMood?: (id: string) => 'idle' | 'thinking';
  busy: boolean;
  error: string;
  onClose?: () => void;
  onAddMember: (botId: string) => void;
  onRemoveMember: (botId: string) => void;
  onAddGroup: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
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
    query
  });
  const speakingNames = view.speaking.map((member) => member.name).join(t('play.group.nameSeparator'));
  const nothingToAdd = view.addBots.length === 0 && view.addGroups.length === 0;

  return (
    <div className="play-group-drawer" data-testid="play-group-member-drawer">
      <div className="play-group-drawer__block" data-testid="play-group-current-members">
        <div className="play-group-drawer__bar">
          <h4>{t('play.group.currentMembers')}</h4>
          {onClose ? <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('play.group.closeMembers')}</button> : null}
        </div>
        {speakingNames ? <p data-testid="play-group-drawer-speaking">{t('play.group.speakingNow', { names: speakingNames })}</p> : null}
        <ul className="play-group-drawer__members">
          {view.current.map((member) => {
            const modelName = roomMemberModelLabel(models, member.id);
            return (
              <li key={member.id}>
                <span className="play-group-member">
                  <BotFace name={member.name} mood={faceMood(member.id)} size="sm" testId={`room-member-face-${member.id}`} />
                  <span className="play-group-member__identity">
                    <span>{member.name}</span>
                    {modelName ? (
                      <span className="play-group-member__model" data-testid={`room-member-model-${member.id}`}>{modelName}</span>
                    ) : null}
                  </span>
                  {member.host ? <span className="play-group-badge" data-testid="play-group-host">{t('play.group.hostBadge')}</span> : null}
                  {member.speaking ? <span className="play-group-badge">{t('play.group.speakingBadge')}</span> : null}
                  {member.removable ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || memberIds.length <= 2}
                      aria-label={t('play.group.removeAria', { name: member.name })}
                      onClick={() => onRemoveMember(member.id)}
                    >
                      {t('play.group.remove')}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {memberIds.length <= 2 ? <p className="play-group-hint">{t('play.group.keepTwo')}</p> : null}
      </div>
      <div className="play-group-drawer__block" data-testid="play-group-add-members">
        <h4>{t('play.group.addMembers')}</h4>
        <input
          data-testid="play-group-member-search"
          aria-label={t('play.group.membersSearch')}
          placeholder={t('play.group.membersSearchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="play-group-drawer__members">
          {view.addBots.map((bot) => (
            <li key={bot.id} className="play-group-drawer__add-row">
              <span>{bot.name}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid={`play-group-add-member-${bot.id}`}
                disabled={busy}
                aria-label={t('play.group.addAria', { name: bot.name })}
                onClick={() => onAddMember(bot.id)}
              >
                {t('play.group.add')}
              </button>
            </li>
          ))}
          {view.addGroups.map((group) => (
            <li key={group.id} className="play-group-drawer__add-row" data-testid={`play-group-add-group-row-${group.id}`}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid={`play-group-add-group-${group.id}`}
                disabled={busy}
                aria-label={t('play.group.addGroupAria', { name: group.name })}
                onClick={() => onAddGroup(group.id)}
              >
                {t('play.group.addGroupRow', { name: group.name })}
              </button>
            </li>
          ))}
        </ul>
        {nothingToAdd ? <p className="play-group-hint">{t('play.group.addEmpty')}</p> : null}
      </div>
      {error ? <p className="play-group-error">{error}</p> : null}
    </div>
  );
}
