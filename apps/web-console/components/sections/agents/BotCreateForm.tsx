'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { botNameIssue } from '@/lib/agents-view';
import type { BotFaceColor, BotFaceShape } from '@/lib/bot-face';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotFaceChoice } from '../../BotFaceChoice';
import { Disclosure } from './Disclosure';

interface BotCreateFormProps {
  onCreated: (bot: BotInfo) => void;
  onCancel: () => void;
}

export function BotCreateForm({ onCreated, onCancel }: BotCreateFormProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [shape, setShape] = useState<BotFaceShape | null>(null);
  const [color, setColor] = useState<BotFaceColor | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = botNameIssue(name);
  const showNameError = touched && issue === 'empty';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (issue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: { name: string; title?: string; description?: string; faceShape?: BotFaceShape; faceColor?: BotFaceColor } = {
        name: name.trim()
      };
      if (title.trim()) body.title = title.trim();
      if (description.trim()) body.description = description.trim();
      if (shape) body.faceShape = shape;
      if (color) body.faceColor = color;
      const data = (await api('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })) as { bot: BotInfo };
      onCreated(data.bot);
    } catch (err) {
      setError(t('agents.bots.createFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ag-panel ag-form" aria-label={t('agents.bots.createTitle')} onSubmit={(e) => void submit(e)} noValidate>
      <div>
        <h3 className="ag-panel__title">{t('agents.bots.createTitle')}</h3>
        <p className="ag-panel__lead">{t('agents.bots.createDesc')}</p>
      </div>
      <BotFaceChoice name={name} shape={shape} color={color} onShape={setShape} onColor={setColor} disabled={busy}>
        <label className="ag-field">
          <span className="sr-only">{t('agents.bots.nameLabel')}</span>
          <input
            className="ag-input"
            value={name}
            autoFocus
            placeholder={t('agents.bots.namePh')}
            aria-invalid={showNameError}
            aria-required="true"
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
          />
          {showNameError ? <span className="ag-field__error" role="alert">{t('agents.bots.nameRequired')}</span> : null}
        </label>
      </BotFaceChoice>
      <Disclosure label={t('agents.common.advanced')}>
        <label className="ag-field">
          <span className="ag-field__label">{t('agents.bots.titleLabel')}</span>
          <input className="ag-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          <span className="ag-field__hint">{t('agents.bots.titleHint')}</span>
        </label>
        <label className="ag-field">
          <span className="ag-field__label">{t('agents.bots.descLabel')}</span>
          <textarea
            className="ag-input"
            rows={3}
            value={description}
            placeholder={t('agents.bots.descPh')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </Disclosure>
      {error ? (
        <p className="ag-status ag-status--err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ag-form__actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || issue !== null}>
          {busy ? t('agents.bots.submitting') : t('agents.bots.submit')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t('agents.bots.cancel')}
        </button>
      </div>
    </form>
  );
}
