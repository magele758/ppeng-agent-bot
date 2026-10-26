'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  loadGroupReplyMode,
  saveGroupReplyMode,
  type GroupReplyMode
} from '@/lib/group-reply-mode';
import { useI18n, type MessageKey } from '@/lib/i18n';
import './play-group.css';

const OPTIONS: readonly { mode: GroupReplyMode; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { mode: 'coordinator', labelKey: 'play.groupSettings.coordinator', hintKey: 'play.groupSettings.coordinatorHint' },
  { mode: 'task-collaboration', labelKey: 'play.groupSettings.taskCollaboration', hintKey: 'play.groupSettings.taskCollaborationHint' },
  { mode: 'all-members', labelKey: 'play.groupSettings.allMembers', hintKey: 'play.groupSettings.allMembersHint' }
];

export function GroupReplyModeControl({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<GroupReplyMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setMode(null);
    setError('');
    void loadGroupReplyMode(api, roomId)
      .then((loaded) => {
        if (active) setMode(loaded);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error && cause.message ? cause.message : t('play.groupSettings.saveFailed'));
      });
    return () => {
      active = false;
    };
  }, [roomId, t]);

  async function choose(next: GroupReplyMode) {
    if (mode === null || next === mode || busy) return;
    const previous = mode;
    setBusy(true);
    setMode(next);
    setError('');
    const result = await saveGroupReplyMode(api, roomId, previous, next);
    setMode(result.mode);
    setError(result.saved ? '' : result.error === 'not-confirmed' ? t('play.groupSettings.saveFailed') : result.error);
    setBusy(false);
  }

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
              disabled={mode === null || busy}
              onChange={() => void choose(option.mode)}
            />
            <span>{t(option.labelKey)}</span>
            <small className="play-group-reply-mode__hint">{t(option.hintKey)}</small>
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="play-group-reply-mode__error" data-testid="group-reply-mode-error">{error}</p> : null}
    </fieldset>
  );
}
