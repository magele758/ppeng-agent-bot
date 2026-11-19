'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  BOT_EFFORT_FOLLOW_GLOBAL,
  BOT_EFFORT_LEVELS,
  botEffortEffectiveText,
  botEffortFollowLabel,
  botEffortFromSelect,
  botEffortLevelLabel,
  botEffortSelectValue,
  readGlobalThinkingEffort,
  type BotThinkingEffort
} from '@/lib/bot-thinking-effort';
import { ConfigGroup, FieldLabel } from './ConfigGroup';

const GLOBAL_EFFORT_PATH = '/api/thinking-effort/settings';

/** Level saved on the global card; null until loaded or when it cannot be read. */
function useGlobalThinkingEffort(): BotThinkingEffort | null {
  const [level, setLevel] = useState<BotThinkingEffort | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api(GLOBAL_EFFORT_PATH)
      .then((data) => {
        if (!cancelled) setLevel(readGlobalThinkingEffort(data));
      })
      .catch(() => {
        if (!cancelled) setLevel(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return level;
}

export function BotThinkingEffortSetting({
  botId,
  pinned,
  onSave
}: {
  botId: string | null;
  pinned: BotThinkingEffort | null;
  onSave: (next: BotThinkingEffort | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const globalLevel = useGlobalThinkingEffort();

  const save = async (value: string) => {
    if (!botId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave(botEffortFromSelect(value));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfigGroup title={t('play.botEffort.title')} tip={t('play.botEffort.tip')}>
      {err ? <p className="bot-cron-panel__err">{err}</p> : null}
      <label className="field field--inline">
        <FieldLabel>{t('play.botEffort.label')}</FieldLabel>
        <select
          id="botThinkingEffortSelect"
          value={botEffortSelectValue(pinned)}
          disabled={!botId || busy}
          aria-label={t('play.botEffort.aria')}
          onChange={(e) => void save(e.target.value)}
        >
          <option value={BOT_EFFORT_FOLLOW_GLOBAL}>{botEffortFollowLabel(t, globalLevel)}</option>
          {BOT_EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {botEffortLevelLabel(t, level)}
            </option>
          ))}
        </select>
      </label>
      <p className="bot-cron-card__meta" data-testid="bot-effort-effective">
        {botEffortEffectiveText(t, pinned, globalLevel)}
      </p>
      <p className="bot-cron-card__meta">{t('play.botEffort.hint')}</p>
    </ConfigGroup>
  );
}
