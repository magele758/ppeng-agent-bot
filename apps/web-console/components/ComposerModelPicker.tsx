'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  encodeModelValue,
  groupPickerOptionsByProvider,
  isEnvFallbackOption,
  resolvePickerModelRef,
  type ModelPickerOption,
  type ModelRef
} from '@/lib/model-providers';

export type ComposerModelPickerProps = {
  options: readonly ModelPickerOption[];
  modelRef: ModelRef | null;
  /** Persisted Lab catalog default (not env / effective fallback). */
  defaultRef?: ModelRef | null;
  onSelect: (next: ModelRef | null) => void;
  onManage: () => void;
  /** Set when a Bot pins its own model: the trigger is locked and shows this text. */
  lockedReason?: string;
};

export function ComposerModelPicker({
  options,
  modelRef,
  defaultRef = null,
  onSelect,
  onManage,
  lockedReason
}: ComposerModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const visibleOptions = useMemo(
    () => options.filter((o) => !isEnvFallbackOption(o)),
    [options]
  );
  const groups = useMemo(() => groupPickerOptionsByProvider(visibleOptions), [visibleOptions]);
  const resolvedRef = useMemo(
    () => resolvePickerModelRef(visibleOptions, modelRef, defaultRef),
    [visibleOptions, modelRef, defaultRef]
  );
  const currentValue = modelRef ? encodeModelValue(modelRef) : '';
  const current = visibleOptions.find(
    (o) => o.providerId === resolvedRef?.providerId && o.modelId === resolvedRef?.modelId
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="composer-model-module" ref={rootRef}>
      <span className="composer-model-module__kicker">{t('play.availableModels')}</span>
      <button
        type="button"
        id="playModelSelect"
        className={`composer-model-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('play.selectAvailableModel')}
        disabled={Boolean(lockedReason)}
        title={lockedReason}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="composer-model-trigger__provider">
          {current ? (modelRef ? current.providerName : t('settings.model.globalDefault.following', { provider: current.providerName })) : (visibleOptions.length ? t('play.model.pick') : t('play.model.none'))}
        </span>
        {current ? <span className="composer-model-trigger__model">{current.modelId}</span> : null}
      </button>
      {open ? (
        <div className="composer-model-panel" role="listbox" aria-label={t('play.availableModels')}>
          <button type="button" role="option" aria-selected={!modelRef}
            className={`composer-model-option${!modelRef ? ' is-selected' : ''}`}
            onClick={() => { onSelect(null); setOpen(false); }}>
            {t('settings.model.globalDefault.follow')}
          </button>
          {!groups.length ? (
            <p className="composer-model-panel__empty">{t('play.model.empty')}</p>
          ) : (
            groups.map((g) => (
              <div key={g.providerId} className="composer-model-group" role="group" aria-label={g.providerName}>
                <div className="composer-model-group__name">{g.providerName}</div>
                <ul>
                  {g.options.map((o) => {
                    const value = encodeModelValue(o);
                    const selected = value === currentValue;
                    return (
                      <li key={value}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`composer-model-option${selected ? ' is-selected' : ''}`}
                          onClick={() => {
                            onSelect({ providerId: o.providerId, modelId: o.modelId });
                            setOpen(false);
                          }}
                        >
                          {o.modelId}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
          <button
            type="button"
            className="composer-model-panel__manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            {t('play.manageProviders')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
