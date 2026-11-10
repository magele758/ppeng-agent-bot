'use client';

import { useState, useSyncExternalStore } from 'react';
import type { GroupReplyMode } from '@/lib/group-reply-mode';
import { roomReplySelection } from './reply-mode-selection';
import { useI18n, type MessageKey } from '@/lib/i18n';
import './play-group.css';

const OPTIONS: readonly { mode: GroupReplyMode; labelKey: MessageKey; hintKey: MessageKey; flowKey: MessageKey; useKey: MessageKey }[] = [
  { mode: 'coordinator', labelKey: 'play.groupSettings.coordinator', hintKey: 'play.groupSettings.coordinatorHint', flowKey: 'play.groupSettings.coordinatorFlow', useKey: 'play.groupSettings.coordinatorUse' },
  { mode: 'task-collaboration', labelKey: 'play.groupSettings.taskCollaboration', hintKey: 'play.groupSettings.taskCollaborationHint', flowKey: 'play.groupSettings.collaborationFlow', useKey: 'play.groupSettings.collaborationUse' },
  { mode: 'all-members', labelKey: 'play.groupSettings.allMembers', hintKey: 'play.groupSettings.allMembersHint', flowKey: 'play.groupSettings.allMembersFlow', useKey: 'play.groupSettings.allMembersUse' }
];

export function GroupReplyModeControl({ roomId, initialMode }: { roomId: string; initialMode: GroupReplyMode }) {
  const { t } = useI18n();
  const [selection] = useState(() => roomReplySelection(roomId, initialMode));
  const { mode, error } = useSyncExternalStore(selection.subscribe, selection.snapshot, selection.snapshot);

  return (
    <fieldset className="play-group-reply-mode" data-testid="group-reply-mode">
      <legend>{t('play.groupSettings.replyMode')}</legend>
      <p className="play-group-reply-mode__note">{t('play.groupSettings.instantHint')}</p>
      <div className="play-group-reply-mode__options" role="radiogroup" aria-label={t('play.groupSettings.replyMode')}>
        {OPTIONS.map((option) => (
          <label key={option.mode} className={`play-group-reply-mode__option${mode === option.mode ? " is-selected" : ""}`}>
            <input
              type="radio"
              name="group-reply-mode"
              value={option.mode}
              data-testid={`group-reply-mode-${option.mode}`}
              checked={mode === option.mode}
              onChange={() => void selection.choose(option.mode)}
            />
            <span>{t(option.labelKey)}</span>
            <small className="play-group-reply-mode__hint">{t(option.hintKey)}</small>
          </label>
        ))}
      </div>
      <details className="play-group-mode-guide" data-testid="group-mode-guide">
        <summary>{t('play.groupSettings.guideTitle')}</summary>
        {OPTIONS.map(option => (
          <section key={option.mode}>
            <h4>{t(option.labelKey)}</h4>
            <p>{t(option.flowKey)}</p>
            <p className="play-group-mode-guide__use">{t(option.useKey)}</p>
          </section>
        ))}
        <p>{t('play.groupSettings.mentionRules')}</p>
      </details>
      {error ? <p role="alert" className="play-group-reply-mode__error" data-testid="group-reply-mode-error">{error === 'not-confirmed' ? t('play.groupSettings.saveFailed') : error}</p> : null}
    </fieldset>
  );
}
