'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type I18nContextValue, type MessageKey } from '@/lib/i18n';
import {
  MODEL_PROVIDER_PRESETS,
  baseUrlFromModelsEndpoint,
  classifyScanError,
  defaultEnabledModelIds,
  pickDefaultModel,
  type ModelProviderKind,
  type ModelProvidersResponse,
  type PreviewScanResponse,
  type PublicModelProvider,
  type RemoteModelHint
} from '@/lib/model-providers';
import { SaveStatus } from './sections/settings/SaveStatus';
import { useAdvancedMode } from './ui';
import './sections/settings/settings.css';

const KIND_IDS: ModelProviderKind[] = ['openai-compatible', 'anthropic-compatible'];

function presetLabel(id: string, fallback: string, t: I18nContextValue['t']): string {
  if (id === 'custom') return t('settings.model.customProvider');
  if (id === 'siliconflow') return t('settings.model.presetSiliconflow');
  return fallback;
}

function kindLabel(id: ModelProviderKind, t: I18nContextValue['t']): string {
  switch (id) {
    case 'openai-compatible':
      return t('nav.kindOpenai');
    case 'anthropic-compatible':
      return t('nav.kindAnthropic');
    case 'heuristic':
      return t('nav.kindHeuristic');
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

type TestState = 'idle' | 'testing' | 'ok' | 'error';

export type ModelSetupFormProps = {
  onSaved: (data: ModelProvidersResponse & { provider?: PublicModelProvider }) => void;
  onCancel?: () => void;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Guided flow: provider → API key → test connection → pick model → save. Advanced is opt-in. */
export function ModelSetupForm({ onSaved, onCancel }: ModelSetupFormProps) {
  const { t } = useI18n();
  const [globalAdvanced] = useAdvancedMode();
  const [advancedLocal, setAdvancedLocal] = useState<boolean | null>(null);
  const advancedOpen = advancedLocal ?? globalAdvanced;

  const [presetId, setPresetId] = useState('openai');
  const preset = MODEL_PROVIDER_PRESETS.find((p) => p.id === presetId) ?? MODEL_PROVIDER_PRESETS[0]!;
  const [kind, setKind] = useState<ModelProviderKind>(preset.kind);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [apiKey, setApiKey] = useState(preset.apiKeyHint ?? '');
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState('');
  const [suggestedName, setSuggestedName] = useState('');

  const [test, setTest] = useState<TestState>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [models, setModels] = useState<RemoteModelHint[]>([]);
  const [enabledIds, setEnabledIds] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [manualModel, setManualModel] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ model: string } | null>(null);

  const isCustom = presetId === 'custom';
  const chosenModel = manualModel.trim() || defaultModel.trim();
  const canTest = Boolean(baseUrl.trim() && apiKey.trim()) && test !== 'testing' && !saving;
  const canSave = Boolean(baseUrl.trim() && apiKey.trim() && chosenModel) && !saving && test !== 'testing';
  const dirty = !saved && (apiKey !== (preset.apiKeyHint ?? '') || name.trim() !== '' || test === 'ok');
  const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

  const resetTest = () => {
    setTest('idle');
    setTestError(null);
    setModels([]);
    setEnabledIds([]);
    setDefaultModel('');
    setSaveError(null);
  };

  const choosePreset = (id: string) => {
    const next = MODEL_PROVIDER_PRESETS.find((p) => p.id === id);
    if (!next) return;
    setPresetId(id);
    setKind(next.kind);
    setBaseUrl(next.baseUrl);
    setApiKey((cur) => {
      if (next.apiKeyHint && !cur.trim()) return next.apiKeyHint;
      if (preset.apiKeyHint && cur === preset.apiKeyHint) return '';
      return cur;
    });
    resetTest();
  };

  const errorText = (raw: string | undefined): string => {
    const kindOfError = classifyScanError(raw);
    if (kindOfError === 'unknown') {
      return t('settings.model.errors.unknown', { detail: (raw ?? '').slice(0, 160) || '—' });
    }
    return t(`settings.model.errors.${kindOfError}` as MessageKey);
  };

  const runTest = async (): Promise<boolean> => {
    setTest('testing');
    setTestError(null);
    setSaveError(null);
    try {
      const res = (await api('/api/model-providers/preview-scan', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ kind, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      })) as PreviewScanResponse;
      if (!res.ok) {
        setTest('error');
        setTestError(errorText(res.error));
        return false;
      }
      const derived = res.endpoint ? baseUrlFromModelsEndpoint(res.endpoint) : undefined;
      if (derived && kind === 'openai-compatible') setBaseUrl(derived);
      const pick = pickDefaultModel(res.models, presetId);
      setModels(res.models);
      setDefaultModel(pick ?? '');
      setEnabledIds(defaultEnabledModelIds(res.models, pick));
      setSuggestedName(res.suggestedName ?? '');
      setTest('ok');
      return true;
    } catch (e) {
      setTest('error');
      setTestError(errorText(e instanceof Error ? e.message : String(e)));
      return false;
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const selected = chosenModel;
      const known = new Set(models.map((m) => m.id));
      const all: RemoteModelHint[] = known.has(selected) ? models : [...models, { id: selected }];
      const enabled = new Set(enabledIds);
      enabled.add(selected);
      const created = (await api('/api/model-providers', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: name.trim() || suggestedName || presetLabel(preset.id, preset.label, t),
          kind,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          useJsonMode: true,
          models: all.map((m) => ({ id: m.id, ownedBy: m.ownedBy, enabled: enabled.has(m.id) }))
        })
      })) as ModelProvidersResponse & { provider?: PublicModelProvider };
      let next = created;
      if (created.provider?.id) {
        next = {
          ...((await api('/api/model-providers/default', {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify({ defaultRef: { providerId: created.provider.id, modelId: selected } })
          })) as ModelProvidersResponse),
          provider: created.provider
        };
      }
      setSaved({ model: selected });
      onSaved(next);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const startOver = () => {
    setSaved(null);
    setName('');
    setApiKey(preset.apiKeyHint ?? '');
    setManualModel('');
    resetTest();
  };

  if (saved) {
    return (
      <section className="model-wizard model-wizard--done" id="model-wizard" aria-label={t('settings.model.wizardTitle')}>
        <SaveStatus state="saved" savedLabel={t('settings.model.savedUse', { name: saved.model })} />
        <div className="model-wizard__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={startOver}>
            {t('settings.model.addAnother')}
          </button>
          {onCancel ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onCancel}>
              {t('settings.model.done')}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="model-wizard" id="model-wizard" aria-label={t('settings.model.wizardTitle')}>
      <div className="wizard-step">
        <h4 className="wizard-step__title">
          <span className="wizard-step__n" aria-hidden="true">1</span>
          {t('settings.model.stepProvider')}
        </h4>
        <div className="chip-row" role="radiogroup" aria-label={t('settings.model.providerGroup')}>
          {MODEL_PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={presetId === p.id}
              className={`chip${presetId === p.id ? ' is-on' : ''}`}
              disabled={saving}
              onClick={() => choosePreset(p.id)}
            >
              {presetLabel(p.id, p.label, t)}
            </button>
          ))}
        </div>
      </div>

      <div className="wizard-step">
        <h4 className="wizard-step__title">
          <span className="wizard-step__n" aria-hidden="true">2</span>
          {t('settings.model.stepKey')}
        </h4>
        {isCustom ? (
          <label className="field">
            <span>{t('nav.baseUrl')}</span>
            <input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                resetTest();
              }}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}
        <div className="field">
          <label htmlFor="model-wizard-key">{t('settings.model.apiKey')}</label>
          <div className="input-with-action">
            <input
              id="model-wizard-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                resetTest();
              }}
              placeholder={t('settings.model.apiKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-pressed={showKey}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? t('settings.model.hideKey') : t('settings.model.showKey')}
            </button>
          </div>
        </div>
        <p className="muted small">{t('settings.model.apiKeyHint')}</p>
      </div>

      <div className="wizard-step">
        <h4 className="wizard-step__title">
          <span className="wizard-step__n" aria-hidden="true">3</span>
          {t('settings.model.stepTest')}
        </h4>
        <div className="model-wizard__actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={!canTest} onClick={() => void runTest()}>
            {test === 'testing' ? t('settings.model.testing') : t('settings.model.test')}
          </button>
          {!canTest && test !== 'testing' && !apiKey.trim() ? (
            <span className="muted small">{t('settings.model.needKey')}</span>
          ) : null}
        </div>
        {test === 'ok' ? (
          <p className="save-status save-status--saved" role="status">
            <span className="save-status__dot" aria-hidden="true" />
            {models.length
              ? t('settings.model.testOk', { count: models.length })
              : t('settings.model.testOkNoModels')}
          </p>
        ) : null}
        {test === 'error' && testError ? (
          <p className="save-status save-status--error" role="alert">
            {testError}
          </p>
        ) : null}
      </div>

      {test === 'ok' || manualModel.trim() ? (
        <div className="wizard-step">
          <h4 className="wizard-step__title">
            <span className="wizard-step__n" aria-hidden="true">4</span>
            {t('settings.model.stepSave')}
          </h4>
          {models.length ? (
            <label className="field">
              <span>{t('settings.model.defaultModel')}</span>
              <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} disabled={saving}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="wizard-advanced">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={advancedOpen}
          aria-controls="model-wizard-advanced"
          onClick={() => setAdvancedLocal(!advancedOpen)}
        >
          {advancedOpen ? t('settings.model.advancedHide') : t('settings.model.advanced')}
        </button>
        {advancedOpen ? (
          <div className="wizard-advanced__body" id="model-wizard-advanced">
            <div className="row-3">
              <label className="field">
                <span>{t('settings.model.name')}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.model.namePlaceholder')}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>{t('nav.protocol')}</span>
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as ModelProviderKind);
                    resetTest();
                  }}
                >
                  {KIND_IDS.map((id) => (
                    <option key={id} value={id}>
                      {kindLabel(id, t)}
                    </option>
                  ))}
                </select>
              </label>
              {isCustom ? null : (
                <label className="field">
                  <span>{t('nav.baseUrl')}</span>
                  <input
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      resetTest();
                    }}
                    placeholder="https://api.example.com/v1"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="field">
                <span>{t('settings.model.manualModel')}</span>
                <input
                  value={manualModel}
                  onChange={(e) => setManualModel(e.target.value)}
                  placeholder={t('settings.model.manualModelPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
            {models.length ? (
              <fieldset className="model-pick-panel">
                <legend>{t('settings.model.enabledModels')}</legend>
                <p className="muted small">{t('settings.model.enabledModelsHint')}</p>
                <div className="model-pick-panel__actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEnabledIds(models.map((m) => m.id))}
                  >
                    {t('nav.selectAll')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEnabledIds(defaultModel ? [defaultModel] : [])}
                  >
                    {t('nav.selectNone')}
                  </button>
                </div>
                <ul className="model-scan-list">
                  {models.map((m) => (
                    <li key={m.id}>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={enabledSet.has(m.id) || m.id === defaultModel}
                          disabled={m.id === defaultModel}
                          onChange={(e) =>
                            setEnabledIds((cur) =>
                              e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id)
                            )
                          }
                        />
                        <code>{m.id}</code>
                        {m.ownedBy ? <span className="muted"> · {m.ownedBy}</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
          </div>
        ) : null}
      </div>

      {saveError ? (
        <p className="save-status save-status--error" role="alert">
          {saveError}
        </p>
      ) : null}
      {dirty && !saveError ? <SaveStatus state="dirty" /> : null}
      <div className="model-wizard__actions model-wizard__footer">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving
            ? t('settings.saveState.saving')
            : chosenModel
              ? t('settings.model.saveAndUse', { name: chosenModel })
              : t('settings.model.saveDisabled')}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        ) : null}
      </div>
    </section>
  );
}
