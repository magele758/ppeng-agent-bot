'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  attentionItems,
  groupItems,
  groupKey,
  itemLabelKey,
  modeKey,
  noteKey,
  reasonKey,
  sourceKey,
  type ConfigNote,
  type EffectiveConfigPayload,
  type EffectiveItem
} from '@/lib/effective-config';
import { useI18n } from '@/lib/i18n';
import { getMessage } from '@/lib/i18n/t';
import type { MessageKey } from '@/lib/i18n/messages/types';

export function EffectiveConfigCard({
  onLoaded,
  onLoadFailed
}: {
  /** Lets a parent (the health overview) fold config warnings into its verdict. */
  onLoaded?: (payload: EffectiveConfigPayload) => void;
  /** True after a failed load, false after a successful one. Not called before the request. */
  onLoadFailed?: (failed: boolean) => void;
}) {
  const { t, messages } = useI18n();
  const [data, setData] = useState<EffectiveConfigPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const payload = (await api('/api/config/effective')) as EffectiveConfigPayload;
      setData(payload);
      onLoaded?.(payload);
      onLoadFailed?.(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onLoadFailed?.(true);
    } finally {
      setBusy(false);
    }
  }, [onLoaded, onLoadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 优先用 i18n 文案；API 新增了前端还没翻译的 code 时退回服务端英文兜底。 */
  const translateCode = (key: string, fallback: string, params?: Record<string, string | number>) =>
    getMessage(messages, key) !== undefined ? t(key as MessageKey, params) : fallback;

  const noteText = (n: ConfigNote) => translateCode(noteKey(n.code), n.message, n.params);
  const reasonText = (it: EffectiveItem) => translateCode(reasonKey(it.reasonCode), it.reason, it.params);

  const renderItem = (it: EffectiveItem) => (
    <div key={it.id} className={`list-item ops-cfg__item${it.warnings.length ? ' ops-cfg__item--warn' : ''}`} data-testid={`effective-${it.id}`}>
      <div className="ops-cfg__row">
        <strong>{translateCode(itemLabelKey(it.id), it.id)}</strong>
        <span className="badge">
          {it.enabled ? t('config.statusOn') : it.group === 'storage' ? t('config.statusLocal') : t('config.statusOff')}
        </span>
        <span className="badge">{t(sourceKey(it.source))}</span>
        <code className="muted ops-cfg__mode">{it.mode}</code>
      </div>
      <div className="muted ops-cfg__reason">{reasonText(it)}</div>
      {it.warnings.length > 0 ? (
        <ul className="ops-cfg__warnings">
          {it.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} title={t('config.warningsTitle')}>
              {noteText(w)}
            </li>
          ))}
        </ul>
      ) : null}
      {it.hints.length > 0 ? (
        <ul className="muted ops-cfg__hints">
          {it.hints.map((h, i) => (
            <li key={`${h.code}-${i}`} title={t('config.hintsTitle')}>
              {noteText(h)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  if (!data) {
    return (
      <div className="card" id="card-effective-config">
        <div className="card-head">
          <h3>{t('config.title')}</h3>
        </div>
        <div className="empty-hint" role={err ? 'alert' : undefined}>{err ? `${t('config.loadFailed')}: ${err}` : t('config.loading')}</div>
      </div>
    );
  }

  const attention = attentionItems(data.items);
  const hasWarnings = attention.length > 0;

  return (
    <div className="card" id="card-effective-config">
      <div className="card-head">
        <h3>{t('config.title')}</h3>
        <span className="badge" data-testid="effective-mode">
          {t(modeKey(data.mode))}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load()}>
          {t('config.refresh')}
        </button>
      </div>
      <p className="muted ops-cfg__desc">{t('config.desc')}</p>
      <p className="ops-cfg__summary" data-testid="effective-summary">
        {data.mode === 'local' && !hasWarnings
          ? t('config.localOnlyHint')
          : t('config.summaryLine', {
              external: data.summary.externalServices.length,
              auto: data.summary.autoEnabled.length,
              partial: data.summary.partial.length
            })}
      </p>

      {showAll ? null : (
        <div className="ops-cfg__group" data-testid="effective-attention">
          <div className="muted ops-cfg__group-title">{t('ops.cfg.attentionTitle')}</div>
          {hasWarnings ? (
            <div className="ops-cfg__list">{attention.map(renderItem)}</div>
          ) : (
            <p className="muted ops-cfg__none">{t('ops.cfg.noAttention')}</p>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={showAll}
        aria-controls="effective-all-items"
        onClick={() => setShowAll((v) => !v)}
      >
        {showAll ? t('ops.cfg.hideAll') : t('ops.cfg.showAll', { n: data.items.length })}
      </button>

      {showAll ? (
        <div id="effective-all-items" className="ops-cfg__all">
          {groupItems(data.items).map(({ group, items }) => (
            <div key={group} className="ops-cfg__group">
              <div className="muted ops-cfg__group-title">{t(groupKey(group))}</div>
              <div className="ops-cfg__list">{items.map(renderItem)}</div>
            </div>
          ))}
          <p className="muted ops-cfg__howto">{t('config.howToChange')}</p>
        </div>
      ) : null}
      {err ? <div className="ops-cfg__error" role="alert">{err}</div> : null}
    </div>
  );
}
