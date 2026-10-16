'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { groupMemberIds, groupSpeakBudget, BOT_GROUPS_CHANGED_EVENT } from '@/lib/bot-group';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';

interface BotGroupCreateFormProps {
  bots: readonly BotInfo[];
  onCreated: (title: string) => void;
  onCancel: () => void;
}

/** Create a group chat from bots that already exist. Does not create a Bot. */
export function BotGroupCreateForm({ bots, onCreated, onCancel }: BotGroupCreateFormProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = title.trim();
  const titleOk = trimmed.length >= 1 && trimmed.length <= 120;
  const members = groupMemberIds(memberIds, new Set(bots.map((bot) => bot.id)));
  const ready = titleOk && members.ok;

  const toggle = (id: string) => {
    setMemberIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const submit = async () => {
    if (!titleOk) {
      setError(t('play.group.titleInvalid'));
      return;
    }
    if (!members.ok) {
      setError(t('agents.bots.groupNeedTwo'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/bot-rooms', {
        method: 'POST',
        body: JSON.stringify({
          title: trimmed,
          botIds: members.members,
          hostBotId: members.members[0],
          maxBotTurns: groupSpeakBudget(members.members.length)
        })
      });
      window.dispatchEvent(new CustomEvent(BOT_GROUPS_CHANGED_EVENT));
      onCreated(trimmed);
    } catch (err) {
      setError(t('agents.bots.groupFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ag-panel" data-testid="bot-group-create">
      <header className="ag-panel__head">
        <div>
          <h3 className="ag-panel__title">{t('agents.bots.groupTitle')}</h3>
          <p className="ag-panel__lead">{t('agents.bots.groupDesc')}</p>
        </div>
      </header>
      {bots.length < 2 ? (
        <p className="ag-field__hint" data-testid="bot-group-empty">{t('agents.bots.groupEmpty')}</p>
      ) : (
        <form
          className="ag-form"
          aria-label={t('agents.bots.groupTitle')}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="ag-field">
            <span className="ag-field__label">{t('agents.bots.groupNameLabel')}</span>
            <input
              className="ag-input"
              data-testid="bot-group-name"
              value={title}
              maxLength={120}
              required
              autoFocus
              placeholder={t('agents.bots.groupNamePh')}
              onChange={(e) => setTitle(e.target.value)}
            />
            <span className="ag-field__hint">{t('agents.bots.groupNameHint')}</span>
          </label>
          <fieldset className="ag-field">
            <legend className="ag-field__label">{t('agents.bots.groupMembersLabel')}</legend>
            <span className="ag-field__hint">{t('agents.bots.groupMembersHint')}</span>
            <ul className="ag-check-list">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`bot-group-member-${bot.id}`}
                      checked={memberIds.includes(bot.id)}
                      onChange={() => toggle(bot.id)}
                    />
                    <span>{bot.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {!members.ok && memberIds.length > 0 ? (
            <p className="ag-field__error" role="alert">{t('agents.bots.groupNeedTwo')}</p>
          ) : null}
          {error ? <p className="ag-field__error" role="alert">{error}</p> : null}
          <div className="ag-form__actions">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              data-testid="bot-group-submit"
              disabled={busy || !ready}
            >
              {busy ? t('agents.bots.groupSubmitting') : t('agents.bots.groupSubmit')}
            </button>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
              {t('agents.bots.cancel')}
            </button>
          </div>
        </form>
      )}
      {bots.length < 2 ? (
        <div className="ag-form__actions">
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            {t('agents.bots.cancel')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
