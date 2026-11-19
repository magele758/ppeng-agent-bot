'use client';

import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { botPinErrorText } from '@/lib/bot-pin-error';
import {
  BOT_MODEL_FOLLOW_DEFAULT,
  botModelPickable,
  botModelPinIsStale,
  botModelSelectValue
} from '@/lib/bot-model';
import {
  decodeModelValue,
  encodeModelValue,
  groupPickerOptionsByProvider,
  type ModelPickerOption,
  type ModelRef
} from '@/lib/model-providers';
import { ConfigGroup, FieldLabel } from './ConfigGroup';

export function BotModelSetting({
  botId,
  pinned,
  options,
  defaultRef,
  onSave
}: {
  botId: string | null;
  pinned: ModelRef | null;
  options: readonly ModelPickerOption[];
  defaultRef: ModelRef | null;
  onSave: (next: ModelRef | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => groupPickerOptionsByProvider(botModelPickable(options)), [options]);
  const stale = botModelPinIsStale(pinned, options);
  const defaultLabel = defaultRef ? `${defaultRef.modelId}` : null;

  const save = async (value: string) => {
    if (!botId || busy) return;
    const next = value === BOT_MODEL_FOLLOW_DEFAULT ? null : (decodeModelValue(value) ?? null);
    setBusy(true);
    setErr(null);
    try {
      await onSave(next);
    } catch (e) {
      setErr(botPinErrorText(t, e, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfigGroup title={t('play.botModel.title')} tip={t('play.botModel.tip')}>
      {err ? <p className="bot-cron-panel__err">{err}</p> : null}
      <label className="field field--inline">
        <FieldLabel>{t('play.botModel.label')}</FieldLabel>
        <select
          id="botModelSelect"
          value={botModelSelectValue(pinned)}
          disabled={!botId || busy}
          aria-label={t('play.botModel.aria')}
          onChange={(e) => void save(e.target.value)}
        >
          <option value={BOT_MODEL_FOLLOW_DEFAULT}>
            {defaultLabel
              ? t('play.botModel.followDefaultWith', { model: defaultLabel })
              : t('play.botModel.followDefault')}
          </option>
          {stale && pinned ? (
            <option value={encodeModelValue(pinned)}>
              {t('play.botModel.unavailableOption', { model: pinned.modelId })}
            </option>
          ) : null}
          {groups.map((g) => (
            <optgroup key={g.providerId} label={g.providerName}>
              {g.options.map((o) => (
                <option key={encodeModelValue(o)} value={encodeModelValue(o)}>
                  {o.modelId}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {stale ? (
        <p className="bot-cron-panel__err" role="status">
          {t('play.botModel.unavailable')}
        </p>
      ) : (
        <p className="bot-cron-card__meta">{t('play.botModel.hint')}</p>
      )}
    </ConfigGroup>
  );
}
