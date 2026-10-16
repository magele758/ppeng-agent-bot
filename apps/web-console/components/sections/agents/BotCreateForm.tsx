'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { botNameIssue } from '@/lib/agents-view';
import { BOT_AVATAR_EMOJIS, botAvatarIssue, botAvatarValue } from '@/lib/bot-avatar';
import type { BotFaceColor, BotFaceShape } from '@/lib/bot-face';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotFaceChoice } from '../../BotFaceChoice';
import { Disclosure } from './Disclosure';

interface BotCreateFormProps {
  existingNames: readonly string[];
  onCreated: (bot: BotInfo) => void;
  onCancel: () => void;
}

const EMPTY_FACE: { shape: BotFaceShape | null; color: BotFaceColor | null } = { shape: null, color: null };

/** Create one Bot by name. Icon is optional; title, description and face are advanced. */
export function BotCreateForm({ existingNames, onCreated, onCancel }: BotCreateFormProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [face, setFace] = useState(EMPTY_FACE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameProblem = botNameIssue(name, existingNames);
  const avatarProblem = botAvatarIssue(emoji, imageUrl);
  const trimmedName = name.trim();

  const submit = async () => {
    if (nameProblem === 'empty') {
      setError(t('agents.bots.nameRequired'));
      return;
    }
    if (nameProblem === 'taken') {
      setError(t('agents.bots.nameTaken'));
      return;
    }
    if (avatarProblem) {
      setError(t('agents.bots.avatarInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const avatar = botAvatarValue(emoji, imageUrl);
      const bot = (await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          ...(face.shape ? { faceShape: face.shape } : {}),
          ...(face.color ? { faceColor: face.color } : {}),
          ...(avatar ? { avatar } : {})
        })
      })) as { bot?: BotInfo } | BotInfo;
      const created = bot && typeof bot === 'object' && 'bot' in bot && bot.bot ? bot.bot : (bot as BotInfo);
      onCreated(created);
    } catch (err) {
      setError(t('agents.bots.createFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ag-panel" data-testid="bot-create">
      <header className="ag-panel__head">
        <div>
          <h3 className="ag-panel__title">{t('agents.bots.createTitle')}</h3>
          <p className="ag-panel__lead">{t('agents.bots.createDesc')}</p>
        </div>
      </header>
      <form
        className="ag-form"
        aria-label={t('agents.bots.createTitle')}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="ag-field">
          <span className="ag-field__label">{t('agents.bots.nameLabel')}</span>
          <input
            className="ag-input"
            data-testid="bot-create-name"
            value={name}
            maxLength={64}
            required
            autoFocus
            placeholder={t('agents.bots.namePh')}
            aria-invalid={nameProblem === 'taken' || undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="ag-field__hint">{t('agents.bots.nameHint')}</span>
        </label>

        <fieldset className="ag-field ag-avatar">
          <legend className="ag-field__label">{t('agents.bots.avatarLabel')}</legend>
          <span className="ag-field__hint">{t('agents.bots.avatarHint')}</span>
          <div className="ag-avatar__row" role="radiogroup" aria-label={t('agents.bots.avatarEmojiAria')}>
            <button
              type="button"
              className={`ag-avatar__emoji${emoji ? '' : ' is-selected'}`}
              aria-pressed={!emoji}
              disabled={busy}
              onClick={() => setEmoji('')}
            >
              {t('agents.bots.avatarNone')}
            </button>
            {BOT_AVATAR_EMOJIS.map((mark) => (
              <button
                key={mark}
                type="button"
                className={`ag-avatar__emoji ag-avatar__emoji--mark${emoji === mark ? ' is-selected' : ''}`}
                aria-pressed={emoji === mark}
                aria-label={mark}
                disabled={busy}
                onClick={() => setEmoji(emoji === mark ? '' : mark)}
              >
                {mark}
              </button>
            ))}
          </div>
          <label className="ag-field">
            <span className="ag-field__label">{t('agents.bots.avatarUrlLabel')}</span>
            <input
              className="ag-input"
              data-testid="bot-create-avatar-url"
              type="url"
              inputMode="url"
              value={imageUrl}
              maxLength={500}
              placeholder={t('agents.bots.avatarUrlPh')}
              aria-invalid={avatarProblem === 'invalid' || undefined}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </label>
        </fieldset>

        <Disclosure label={t('agents.common.advanced')}>
          <label className="ag-field">
            <span className="ag-field__label">{t('agents.bots.titleLabel')}</span>
            <input
              className="ag-input"
              data-testid="bot-create-title"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
            <span className="ag-field__hint">{t('agents.bots.titleHint')}</span>
          </label>
          <label className="ag-field">
            <span className="ag-field__label">{t('agents.bots.descLabel')}</span>
            <textarea
              className="ag-input"
              data-testid="bot-create-description"
              rows={3}
              maxLength={2000}
              value={description}
              placeholder={t('agents.bots.descPh')}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="ag-field__hint">{t('agents.bots.descHint')}</span>
          </label>
          <BotFaceChoice
            name={trimmedName}
            shape={face.shape}
            color={face.color}
            disabled={busy}
            onShape={(shape) => setFace((current) => ({ ...current, shape }))}
            onColor={(color) => setFace((current) => ({ ...current, color }))}
          />
        </Disclosure>

        {nameProblem === 'taken' ? (
          <p className="ag-field__error" role="alert">{t('agents.bots.nameTaken')}</p>
        ) : null}
        {avatarProblem ? (
          <p className="ag-field__error" role="alert">{t('agents.bots.avatarInvalid')}</p>
        ) : null}
        {error ? <p className="ag-field__error" role="alert">{error}</p> : null}
        <div className="ag-form__actions">
          <button type="submit" className="btn btn-primary btn-sm" data-testid="bot-create-submit" disabled={busy || !trimmedName || nameProblem !== null || avatarProblem !== null}>
            {busy ? t('agents.bots.submitting') : t('agents.bots.submit')}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
            {t('agents.bots.cancel')}
          </button>
        </div>
      </form>
    </section>
  );
}
