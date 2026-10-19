'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { botNameIssue } from '@/lib/agents-view';
import {
  botCreateBlock,
  botCreateReady,
  buildBotCreatePayload,
  unwrapCreatedBot
} from '@/lib/bot-avatar';
import type { BotFaceColor, BotFaceShape } from '@/lib/bot-face';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotFaceChoice } from '../../BotFaceChoice';

interface BotCreateFormProps {
  existingNames: readonly string[];
  onCreated: (bot: BotInfo) => void;
  onCancel: () => void;
}

const EMPTY_FACE: { shape: BotFaceShape | null; color: BotFaceColor | null } = { shape: null, color: null };

function CreateFieldErrors({
  nameProblem,
  error
}: {
  nameProblem: string | null;
  error: string | null;
}) {
  const { t } = useI18n();
  return (
    <>
      {nameProblem === 'taken' ? <p className="ag-field__error" role="alert">{t('agents.bots.nameTaken')}</p> : null}
      {error ? <p className="ag-field__error" role="alert">{error}</p> : null}
    </>
  );
}

/** Create a Bot with an immediately visible face preview and optional appearance choices. */
export function BotCreateForm({ existingNames, onCreated, onCancel }: BotCreateFormProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [face, setFace] = useState(EMPTY_FACE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameProblem = botNameIssue(name, existingNames);

  const submit = async () => {
    const block = botCreateBlock(nameProblem, null);
    if (block === 'name-empty') {
      setError(t('agents.bots.nameRequired'));
      return;
    }
    if (block === 'name-taken') {
      setError(t('agents.bots.nameTaken'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bot = (await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify(buildBotCreatePayload({ name, title, description, emoji: '', imageUrl: '', face }))
      })) as { bot?: BotInfo } | BotInfo;
      onCreated(unwrapCreatedBot(bot));
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
        <div className="ag-form__scroll">
        <div className="ag-field">
          <label className="ag-field__label" htmlFor="bot-create-name">
            {t('agents.bots.nameLabel')}
          </label>
          <input
            id="bot-create-name"
            className="ag-input"
            data-testid="bot-create-name"
            value={name}
            maxLength={64}
            required
            autoFocus
            placeholder={t('agents.bots.namePh')}
            aria-invalid={nameProblem === 'taken' || undefined}
            aria-describedby="bot-create-name-hint"
            onChange={(e) => setName(e.target.value)}
          />
          <span id="bot-create-name-hint" className="ag-field__hint">
            {t('agents.bots.nameHint')}
          </span>
        </div>

        <div className="ag-field">
          <label className="ag-field__label" htmlFor="bot-create-title">
            {t('agents.bots.titleLabel')}
          </label>
          <input
            id="bot-create-title"
            className="ag-input"
            data-testid="bot-create-title"
            value={title}
            maxLength={80}
            aria-describedby="bot-create-title-hint"
            onChange={(e) => setTitle(e.target.value)}
          />
          <span id="bot-create-title-hint" className="ag-field__hint">
            {t('agents.bots.titleHint')}
          </span>
        </div>
        <div className="ag-field">
          <label className="ag-field__label" htmlFor="bot-create-description">
            {t('agents.bots.descLabel')}
          </label>
          <textarea
            id="bot-create-description"
            className="ag-input"
            data-testid="bot-create-description"
            rows={3}
            maxLength={2000}
            value={description}
            placeholder={t('agents.bots.descPh')}
            aria-describedby="bot-create-description-hint"
            onChange={(e) => setDescription(e.target.value)}
          />
          <span id="bot-create-description-hint" className="ag-field__hint">
            {t('agents.bots.descHint')}
          </span>
        </div>
        <BotFaceChoice
          showLabels
          name={name.trim()}
          shape={face.shape}
          color={face.color}
          disabled={busy}
          onShape={(shape) => setFace((current) => ({ ...current, shape }))}
          onColor={(color) => setFace((current) => ({ ...current, color }))}
        />

        </div>
        <CreateFieldErrors nameProblem={nameProblem} error={error} />
        <div className="ag-form__actions">
          <button type="submit" className="btn btn-primary btn-sm" data-testid="bot-create-submit" disabled={!botCreateReady(name, nameProblem, null, busy)}>
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
