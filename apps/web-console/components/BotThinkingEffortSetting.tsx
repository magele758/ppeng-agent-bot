'use client';

import { useEffect, useState } from 'react';
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
import { botPinErrorText } from '@/lib/bot-pin-error';
import { onPageReturn } from '@/lib/page-return';
import { ConfigGroup, FieldLabel } from './ConfigGroup';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

const GLOBAL_EFFORT_PATH = '/api/thinking-effort/settings';

/**
 * Level saved on the global card; null until it has been read. Shares the card's settings
 * store, so saving the card updates it at once; coming back to the page reads it again.
 */
function useGlobalThinkingEffort(): BotThinkingEffort | null {
  const { settings, effective, reload } = useSettingsResource<unknown, unknown>(GLOBAL_EFFORT_PATH);
  useEffect(() => onPageReturn(window, document, () => void reload()), [reload]);
  return readGlobalThinkingEffort({ settings, effective });
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
      setErr(botPinErrorText(t, e, e instanceof Error ? e.message : String(e)));
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
