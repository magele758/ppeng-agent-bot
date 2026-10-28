'use client';

import { useEffect, useId, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';

type Basics = { name: string; title: string; description: string };
function basicsOf(bot: BotInfo): Basics {
  return { name: bot.name, title: bot.title ?? '', description: bot.description ?? '' };
}

export function BotBasics({ bot, onSave }: {
  bot: BotInfo;
  onSave: (patch: Basics) => Promise<{ bot?: BotInfo }>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(() => basicsOf(bot));
  const [baseline, setBaseline] = useState(JSON.stringify(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => {
    if (!dirty) {
      const next = basicsOf(bot);
      setDraft(next);
      setBaseline(JSON.stringify(next));
    }
  }, [bot.name, bot.title, bot.description]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await onSave(draft);
      const saved = result.bot ? basicsOf(result.bot) : draft;
      setDraft(saved);
      setBaseline(JSON.stringify(saved));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <form className="ag-form" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="ag-field"><label htmlFor={`${id}-name`}>{t('botSettings.name')}</label>
      <input id={`${id}-name`} className="ag-input" required maxLength={64} value={draft.name} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} />
    </div>
    <div className="ag-field"><label htmlFor={`${id}-title`}>{t('botSettings.title')}</label>
      <input id={`${id}-title`} className="ag-input" maxLength={80} value={draft.title} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} />
    </div>
    <div className="ag-field"><label htmlFor={`${id}-description`}>{t('botSettings.description')}</label>
      <textarea id={`${id}-description`} className="ag-input" maxLength={2000} rows={3} value={draft.description} disabled={busy} onChange={e => setDraft({ ...draft, description: e.target.value })} />
    </div>
    {dirty && <p>{t('botSettings.unsaved')}</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn btn-primary btn-sm" disabled={busy || !dirty || !draft.name.trim()}>{t('botSettings.saveBasics')}</button>
  </form>;
}
