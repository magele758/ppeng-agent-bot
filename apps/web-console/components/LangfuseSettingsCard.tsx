'use client';

import { useMemo } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { buildPatch } from '@/lib/settings-fields';
import { ExperimentRow } from './ui';
import {
  LoadGate,
  SaveBar,
  StatusLine,
  TextField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

interface LangfuseSettings {
  configured: boolean;
  baseUrl: string;
  publicKeySet: boolean;
  secretKeySet: boolean;
  enabled: boolean;
  chained: boolean;
}

const KEYS = ['baseUrl', 'publicKey', 'secretKey'] as const;
const EMPTY_FORM = { baseUrl: '', publicKey: '', secretKey: '' };

export function LangfuseSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<LangfuseSettings>('/api/langfuse/settings');
  const s = r.settings;
  const base = 'settingsEntries.langfuse';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);

  const saved = useMemo(
    () => (s ? { baseUrl: s.baseUrl, publicKey: '', secretKey: '' } : null),
    [s]
  );
  const form = useDraftForm(saved, EMPTY_FORM);
  const { draft } = form;

  const submit = async () => {
    if (!saved) return;
    const ok = await r.save(buildPatch(draft, saved, KEYS) as Record<string, unknown>);
    if (ok) {
      form.set('publicKey', '');
      form.set('secretKey', '');
    }
  };

  const probe = () =>
    r.run(
      async () =>
        (await api('/api/langfuse/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: draft.baseUrl,
            ...(draft.publicKey.trim() ? { publicKey: draft.publicKey } : {}),
            ...(draft.secretKey.trim() ? { secretKey: draft.secretKey } : {})
          })
        })) as { ok: boolean; error?: string },
      (data) => (data.ok ? label('probeOk') : `${label('probeFail')}${data.error ? ` ${data.error}` : ''}`)
    );

  return (
    <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {s ? (
        <ExperimentRow
          id="card-langfuse"
          switchId="langfuse"
          title={label('title')}
          description={label('desc')}
          on={s.enabled}
          busy={r.busy}
          onChange={(enabled) => void r.save({ enabled })}
        >
          <>
            <TextField
              id="field-langfuseBaseUrl"
              type="url"
              label={label('fields.baseUrl.label')}
              hint={label('fields.baseUrl.hint')}
              placeholder={label('fields.baseUrl.placeholder')}
              value={draft.baseUrl}
              disabled={r.busy}
              defaultText={t('settingsEntries.common.none')}
              isDefault={draft.baseUrl === ''}
              onRestore={() => form.set('baseUrl', '')}
              onChange={(v) => form.set('baseUrl', v)}
            />
            <TextField
              id="field-langfusePublicKey"
              type="password"
              label={label('fields.publicKey.label')}
              hint={label('fields.publicKey.hint')}
              placeholder={s.publicKeySet ? t('settingsEntries.common.keepSecret') : ''}
              value={draft.publicKey}
              disabled={r.busy}
              onChange={(v) => form.set('publicKey', v)}
            />
            <TextField
              id="field-langfuseSecretKey"
              type="password"
              label={label('fields.secretKey.label')}
              hint={label('fields.secretKey.hint')}
              placeholder={s.secretKeySet ? t('settingsEntries.common.keepSecret') : ''}
              value={draft.secretKey}
              disabled={r.busy}
              onChange={(v) => form.set('secretKey', v)}
            />
            <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submit()} onReset={form.reset}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={r.busy || !draft.baseUrl.trim()}
                onClick={() => void probe()}
              >
                {label('probe')}
              </button>
            </SaveBar>
            <p className="muted small">{s.configured ? label('configured') : label('unconfigured')}</p>
          </>
        </ExperimentRow>
      ) : null}
      <StatusLine status={r.status} />
    </LoadGate>
  );
}
