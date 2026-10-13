'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  MODEL_PROVIDERS_CHANGED_EVENT,
  decodeModelValue,
  encodeModelValue,
  groupPickerOptionsByProvider,
  type ModelProvidersResponse,
  type PublicModelProvider
} from '@/lib/model-providers';
import { ModelSetupForm } from './ModelSetupForm';
import { SaveStatus } from './sections/settings/SaveStatus';
import { SettingsGroup, useAdvancedMode } from './ui';
import './sections/settings/settings.css';

export type ModelProvidersCardProps = {
  onCatalogChange?: (data: ModelProvidersResponse) => void;
  heading?: string;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function providerStatus(p: PublicModelProvider): 'error' | 'ok' | 'unchecked' | 'builtin' {
  if (p.source === 'builtin' || p.kind === 'heuristic') return 'builtin';
  if (p.scanError) return 'error';
  if (p.scannedAt || p.models.some((m) => m.enabled)) return 'ok';
  return 'unchecked';
}

export function ModelProvidersCard({ onCatalogChange, heading }: ModelProvidersCardProps) {
  const { t } = useI18n();
  const [advanced] = useAdvancedMode();
  const [data, setData] = useState<ModelProvidersResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<Record<string, string>>({});
  const autoOpenedRef = useRef(false);
  const onCatalogChangeRef = useRef(onCatalogChange);
  onCatalogChangeRef.current = onCatalogChange;
  const loadedRef = useRef(false);

  const apply = useCallback((next: ModelProvidersResponse) => {
    setData(next);
    onCatalogChangeRef.current?.(next);
    if (loadedRef.current) window.dispatchEvent(new Event(MODEL_PROVIDERS_CHANGED_EVENT));
    loadedRef.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = (await api('/api/model-providers')) as ModelProvidersResponse;
        if (!cancelled) {
          apply(next);
          setLoadState('ready');
        }
      } catch {
        if (!cancelled) {
          setData(null);
          setLoadState('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const providers = data?.catalog.providers ?? [];
  const uiProviders = providers.filter((p) => p.source === 'ui');
  const defaultRef = data?.catalog.defaultRef ?? null;

  useEffect(() => {
    if (autoOpenedRef.current || !data) return;
    autoOpenedRef.current = true;
    if (uiProviders.length === 0) setAdding(true);
  }, [data, uiProviders.length]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const patchProvider = async (id: string, body: Record<string, unknown>) =>
    (await api(`/api/model-providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    })) as ModelProvidersResponse;

  const scan = (id: string) =>
    run(async () => {
      const next = (await api(`/api/model-providers/${encodeURIComponent(id)}/scan`, {
        method: 'POST'
      })) as ModelProvidersResponse & { ok?: boolean; error?: string; scanned?: number };
      apply(next);
      setNotice(
        next.ok === false
          ? { kind: 'error', text: next.error || t('more.scanFailed') }
          : { kind: 'ok', text: t('more.scanned', { count: next.scanned ?? 0 }) }
      );
    });

  const remove = (id: string) =>
    run(async () => {
      apply((await api(`/api/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })) as ModelProvidersResponse);
      setConfirmDeleteId(null);
      setNotice({ kind: 'ok', text: t('more.deleted') });
    });

  const setDefault = (providerId: string, modelId: string) =>
    run(async () => {
      apply(
        (await api('/api/model-providers/default', {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ defaultRef: { providerId, modelId } })
        })) as ModelProvidersResponse
      );
      setNotice({ kind: 'ok', text: t('more.setDefaultMsg', { model: modelId }) });
    });

  const addModel = (provider: PublicModelProvider, rawId: string) => {
    const modelId = rawId.trim();
    if (!modelId) {
      setNotice({ kind: 'error', text: t('more.fillModelId') });
      return Promise.resolve();
    }
    return run(async () => {
      const exists = provider.models.some((m) => m.id === modelId);
      const models = exists
        ? provider.models.map((m) => (m.id === modelId ? { ...m, enabled: true } : m))
        : [...provider.models, { id: modelId, enabled: true }];
      apply(await patchProvider(provider.id, { models }));
      setAddDraft((cur) => ({ ...cur, [provider.id]: '' }));
      setNotice({ kind: 'ok', text: t('more.addedModel', { model: modelId }) });
    });
  };

  const toggleModel = (provider: PublicModelProvider, modelId: string, enabled: boolean) =>
    run(async () => {
      const models = provider.models.map((m) => (m.id === modelId ? { ...m, enabled } : m));
      apply(await patchProvider(provider.id, { models }));
    });

  const saveEdit = (id: string) =>
    run(async () => {
      const patch: Record<string, string> = {};
      if (editBaseUrl.trim()) patch.baseUrl = editBaseUrl.trim();
      if (editApiKey.trim()) patch.apiKey = editApiKey.trim();
      if (!Object.keys(patch).length) {
        setNotice({ kind: 'error', text: t('more.fillUrlOrKey') });
        return;
      }
      apply(await patchProvider(id, patch));
      setEditApiKey('');
      setEditingId(null);
      const next = (await api(`/api/model-providers/${encodeURIComponent(id)}/scan`, {
        method: 'POST'
      })) as ModelProvidersResponse & { ok?: boolean; error?: string; scanned?: number };
      apply(next);
      setNotice(
        next.ok === false
          ? { kind: 'error', text: next.error || t('more.scanFailed') }
          : { kind: 'ok', text: t('settings.model.list.keyUpdated', { count: next.scanned ?? 0 }) }
      );
    });

  const grouped = groupPickerOptionsByProvider(
    (data?.options ?? []).filter((o) => o.kind !== 'heuristic' || providers.every((p) => p.kind === 'heuristic'))
  );
  const defaultLabel = (() => {
    if (!defaultRef) return null;
    const p = providers.find((x) => x.id === defaultRef.providerId);
    return `${p?.name ?? defaultRef.providerId} / ${defaultRef.modelId}`;
  })();

  return (
    <div className="card" id="card-model-providers">
      <SettingsGroup
        title={heading ?? t('more.modelProvidersTitle')}
        description={`${t('settings.model.desc')}${data?.effective.source === 'env' ? ` ${t('more.modelProvidersEnvFallback')}` : ''}`}
      >
        {notice?.kind === 'error' ? <SaveStatus state="error" error={notice.text} /> : null}
        {notice?.kind === 'ok' ? <SaveStatus state="saved" savedLabel={notice.text} /> : null}

        <div className="model-default-row">
          <div className="field">
            <label htmlFor="model-default-select">{t('settings.model.list.current')}</label>
            <select
              id="model-default-select"
              value={defaultRef ? encodeModelValue(defaultRef) : ''}
              disabled={busy || grouped.length === 0}
              onChange={(e) => {
                const ref = decodeModelValue(e.target.value);
                if (ref) void setDefault(ref.providerId, ref.modelId);
              }}
            >
              {!defaultRef ? <option value="">{t('settings.model.list.noDefault')}</option> : null}
              {grouped.map((g) => (
                <optgroup key={g.providerId} label={g.providerName}>
                  {g.options.map((o) => (
                    <option key={encodeModelValue(o)} value={encodeModelValue(o)}>
                      {o.modelId}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {defaultLabel ? <span className="muted small">{defaultLabel}</span> : null}
        </div>

        <div className="model-add-bar">
          <button
            type="button"
            className={`btn btn-sm${adding ? ' btn-ghost' : ' btn-primary'}`}
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? t('more.collapseAdd') : t('more.addProvider')}
          </button>
        </div>
        {adding ? (
          <div className="model-add-panel">
            <ModelSetupForm
              onSaved={(next) => apply(next)}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : null}

        <div className="provider-list">
          {loadState === 'loading' ? <div className="empty-hint">{t('common.loading')}</div> : null}
          {loadState === 'failed' ? <div className="empty-hint">{t('settings.model.list.loadFailed')}</div> : null}
          {loadState === 'ready' && providers.length === 0 ? <div className="empty-hint">{t('more.noProviders')}</div> : null}
          {providers.map((p) => {
            const status = providerStatus(p);
            const isUi = p.source === 'ui';
            const enabledCount = p.models.filter((m) => m.enabled).length;
            return (
              <article key={p.id} className="provider-row" data-testid={`provider-${p.id}`}>
                <div className="provider-row__head">
                  <strong>{p.name}</strong>
                  <span className={`status-pill status-pill--${status}`}>
                    {t(`settings.model.list.status.${status}`)}
                  </span>
                  <span className="muted small provider-row__meta">
                    {isUi ? p.apiKeyMasked || t('more.noKey') : p.source === 'env' ? t('more.fromEnv') : t('more.builtin')}
                    {' · '}
                    {t('settings.model.list.modelCount', { count: enabledCount })}
                  </span>
                </div>
                {advanced && p.baseUrl ? (
                  <div className="muted small">
                    {p.baseUrl}
                    {p.scannedAt ? t('more.scannedAt', { at: p.scannedAt.slice(0, 19).replace('T', ' ') }) : ''}
                  </div>
                ) : null}
                {p.scanError ? <div className="muted err small">{p.scanError}</div> : null}
                {isUi ? (
                  <div className="provider-row__actions">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void scan(p.id)}>
                      {t('settings.model.list.retest')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(editingId === p.id ? null : p.id);
                        setEditBaseUrl(p.baseUrl);
                        setEditApiKey('');
                      }}
                    >
                      {editingId === p.id ? t('more.cancelEdit') : t('settings.model.list.changeKey')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-expanded={openId === p.id}
                      onClick={() => setOpenId(openId === p.id ? null : p.id)}
                    >
                      {t('settings.model.list.manageModels')}
                    </button>
                    {confirmDeleteId === p.id ? (
                      <>
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void remove(p.id)}>
                          {t('settings.model.list.confirmDelete')}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteId(null)}>
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmDeleteId(p.id)}>
                        {t('more.delete')}
                      </button>
                    )}
                  </div>
                ) : null}
                {editingId === p.id ? (
                  <div className="row-3 provider-row__panel">
                    <label className="field">
                      <span>{t('settings.model.apiKey')}</span>
                      <input
                        type="password"
                        value={editApiKey}
                        onChange={(e) => setEditApiKey(e.target.value)}
                        placeholder={t('more.apiKeyKeep')}
                        autoComplete="off"
                      />
                    </label>
                    {advanced ? (
                      <label className="field">
                        <span>{t('nav.baseUrl')}</span>
                        <input value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} autoComplete="off" />
                      </label>
                    ) : null}
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveEdit(p.id)}>
                      {t('more.saveAndRediscover')}
                    </button>
                  </div>
                ) : null}
                {openId === p.id && isUi ? (
                  <div className="provider-row__panel">
                    {isUi ? (
                      <div className="model-add-row">
                        <label className="field">
                          <span>{t('more.addModelId')}</span>
                          <input
                            value={addDraft[p.id] ?? ''}
                            onChange={(e) => setAddDraft((cur) => ({ ...cur, [p.id]: e.target.value }))}
                            placeholder={t('more.addModelPlaceholder')}
                            autoComplete="off"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void addModel(p, addDraft[p.id] ?? '');
                              }
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy || !(addDraft[p.id] ?? '').trim()}
                          onClick={() => void addModel(p, addDraft[p.id] ?? '')}
                        >
                          {t('more.add')}
                        </button>
                      </div>
                    ) : null}
                    {p.models.length ? (
                      <ul className="model-scan-list">
                        {p.models.map((m) => (
                          <li key={m.id}>
                            <label className="toggle">
                              <input
                                type="checkbox"
                                checked={m.enabled}
                                disabled={busy || !isUi}
                                onChange={(e) => void toggleModel(p, m.id, e.target.checked)}
                              />
                              <code>{m.id}</code>
                              {defaultRef?.providerId === p.id && defaultRef.modelId === m.id ? (
                                <span className="status-pill status-pill--ok">{t('settings.model.list.defaultBadge')}</span>
                              ) : null}
                            </label>
                            <label>{t('botWork.fallbackWindow')}<input type="number" min={1024} defaultValue={m.contextWindow??''} disabled={busy||!isUi} onBlur={e=>{const contextWindow=Number(e.target.value);if(contextWindow>=1024&&contextWindow!==m.contextWindow)void run(async()=>{apply(await patchProvider(p.id,{models:p.models.map(model=>model.id===m.id?{...model,contextWindow}:model)}));});}}/></label>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy || !m.enabled}
                              onClick={() => void setDefault(p.id, m.id)}
                            >
                              {t('settings.model.list.makeDefault')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="muted small">{t('more.noModelsFound')}</div>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </SettingsGroup>
    </div>
  );
}
