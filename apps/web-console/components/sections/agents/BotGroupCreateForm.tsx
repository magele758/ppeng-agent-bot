'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import {
  BOT_GROUPS_CHANGED_EVENT,
  groupCreateDraft,
  groupCreateError,
  groupCreateNeedsRoster,
  toggleGroupMember,
  type BotGroupCreateBody
} from '@/lib/bot-group';
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

  const knownIds = new Set(bots.map((bot) => bot.id));
  const draft = groupCreateDraft(title, memberIds, knownIds);

  const toggle = (id: string) => {
    setMemberIds((current) => toggleGroupMember(current, id));
  };

  const submit = async () => {
    if (draft.blockKey) {
      setError(t(draft.blockKey));
      return;
    }
    const body = draft.body as BotGroupCreateBody;
    setBusy(true);
    setError(null);
    try {
      await api('/api/bot-rooms', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      window.dispatchEvent(new CustomEvent(BOT_GROUPS_CHANGED_EVENT));
      onCreated(body.title);
    } catch (err) {
      setError(groupCreateError(err, (error) => t('agents.bots.groupFailed', { error })));
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
      {groupCreateNeedsRoster(bots.length) ? (
        <GroupCreateEmpty onCancel={onCancel} />
      ) : (
        <form
          className="ag-form"
          aria-label={t('agents.bots.groupTitle')}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="ag-form__scroll">
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
          <GroupMemberWarning show={draft.warnMembers} />
          </div>
          {error ? <p className="ag-field__error" role="alert">{error}</p> : null}
          <div className="ag-form__actions">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              data-testid="bot-group-submit"
              disabled={busy || !draft.ready}
            >
              {busy ? t('agents.bots.groupSubmitting') : t('agents.bots.groupSubmit')}
            </button>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
              {t('agents.bots.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function GroupCreateEmpty({ onCancel }: { onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <p className="ag-field__hint" data-testid="bot-group-empty">{t('agents.bots.groupEmpty')}</p>
      <div className="ag-form__actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {t('agents.bots.cancel')}
        </button>
      </div>
    </>
  );
}

function GroupMemberWarning({ show }: { show: boolean }) {
  const { t } = useI18n();
  if (!show) return null;
  return <p className="ag-field__error" role="alert">{t('agents.bots.groupNeedTwo')}</p>;
}
