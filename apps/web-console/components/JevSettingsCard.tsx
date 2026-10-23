'use client';

import { useMemo } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { buildPatch } from '@/lib/settings-fields';
import { SettingsGroup } from './ui';
import {
  LoadGate,
  RiskNotice,
  SaveBar,
  SelectField,
  StatusLine,
  TextField,
  ToggleField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

type JevProfile = 'off' | 'mini' | 'normal' | 'full' | 'max' | 'custom';
type JevPointId =
  | 'goalGate'
  | 'toolGate'
  | 'compact'
  | 'route'
  | 'contextSelect'
  | 'toolSelect'
  | 'skillSelect'
  | 'sagaGate'
  | 'memorySelect'
  | 'recoveryChoice'
  | 'preTurn'
  | 'ptcDecide';

interface JevSettings {
  configured: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  model: string;
  profile: JevProfile;
  armed: boolean;
  points: Partial<Record<JevPointId, boolean>>;
  activePoints: JevPointId[];
  chained: boolean;
  catalog: Array<{ id: JevPointId }>;
  profilePresets: Record<'mini' | 'normal' | 'full' | 'max', JevPointId[]>;
}

const PROFILES: readonly JevProfile[] = ['off', 'mini', 'normal', 'full', 'max', 'custom'];
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_PROFILE: JevProfile = 'off';
const CONNECTION_KEYS = ['baseUrl', 'apiKey', 'model'] as const;
const EMPTY_CONNECTION = { baseUrl: '', apiKey: '', model: DEFAULT_MODEL };

export function JevSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<JevSettings>('/api/jev/settings');
  const s = r.settings;
  const base = 'settingsEntries.jev';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const pointLabel = (id: JevPointId) => label(`options.points.${id}`);

  const saved = useMemo(
    () => (s ? { baseUrl: s.baseUrl, apiKey: '', model: s.model || DEFAULT_MODEL } : null),
    [s]
  );
  const form = useDraftForm(saved, EMPTY_CONNECTION);
  const { draft } = form;

  const submit = async () => {
    if (!saved) return;
    const ok = await r.save(buildPatch(draft, saved, CONNECTION_KEYS) as Record<string, unknown>);
    if (ok) form.set('apiKey', '');
  };

  const probe = () =>
    r.run(
      async () =>
        (await api('/api/jev/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: draft.baseUrl,
            model: draft.model,
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {})
          })
        })) as { ok: boolean },
      (data) => (data.ok ? label('probeOk') : label('probeFail'))
    );

  const profile = s?.profile ?? DEFAULT_PROFILE;
  const entryOk = Boolean(s?.configured);
  const presetPoints =
    s && (profile === 'mini' || profile === 'normal' || profile === 'full' || profile === 'max')
      ? (s.profilePresets?.[profile] ?? s.activePoints)
      : (s?.activePoints ?? []);
  const profileOptions = PROFILES.map((v) => ({ value: v, label: label(`options.profile.${v}`) }));

  return (
    <div className="settings-stack" id="card-jev">
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <SettingsGroup title={label('title')} description={label('desc')}>
            <ToggleField
              id="field-jevArmed"
              label={label('enabledLabel')}
              checked={Boolean(s.armed)}
              disabled={r.busy}
              onChange={(armed) => void r.save({ armed })}
            />
            <p className="muted small" data-testid="jev-effective-state">
              {label(!s.armed ? 'stateOff' : !entryOk ? 'stateNeedsConnection' : s.chained ? 'stateActive' : 'stateNoPoints')}
            </p>
            <p className="muted small">{label('connection.desc')}</p>
            <TextField
              id="field-jevBaseUrl"
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
              id="field-jevApiKey"
              type="password"
              label={label('fields.apiKey.label')}
              hint={label('fields.apiKey.hint')}
              placeholder={s.apiKeySet ? t('settingsEntries.common.keepSecret') : label('fields.apiKey.placeholder')}
              value={draft.apiKey}
              disabled={r.busy}
              onChange={(v) => form.set('apiKey', v)}
            />
            <TextField
              id="field-jevModel"
              label={label('fields.model.label')}
              hint={label('fields.model.hint')}
              value={draft.model}
              disabled={r.busy}
              defaultText={DEFAULT_MODEL}
              isDefault={draft.model === DEFAULT_MODEL}
              onRestore={() => form.set('model', DEFAULT_MODEL)}
              onChange={(v) => form.set('model', v)}
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
            <p className="muted small">{entryOk ? label('configured') : label('unconfigured')}</p>
            <SettingsGroup id="card-jev-stages" title={label('stages.title')} description={label('stages.desc')}>
              {!entryOk ? <RiskNotice>{label('needsEntry')}</RiskNotice> : null}
              <SelectField
                id="field-jevProfile"
                label={label('fields.profile.label')}
                hint={label('fields.profile.hint')}
                value={profile}
                options={profileOptions}
                disabled={r.busy || !entryOk}
                defaultText={label(`options.profile.${DEFAULT_PROFILE}`)}
                isDefault={profile === DEFAULT_PROFILE}
                onRestore={() => void r.save({ profile: DEFAULT_PROFILE })}
                onChange={(next) => void r.save({ profile: next })}
              />
              {profile === 'custom' ? (
                <div className="settings-check-list">
                  <p className="muted small">{label('stages.custom')}</p>
                  {(s.catalog ?? []).map((item) => (
                    <ToggleField
                      key={item.id}
                      id={`field-jevPoint-${item.id}`}
                      label={pointLabel(item.id)}
                      checked={Boolean(s.points?.[item.id])}
                      disabled={r.busy || !entryOk}
                      onChange={(on) => void r.save({ points: { [item.id]: on } })}
                    />
                  ))}
                </div>
              ) : profile !== 'off' ? (
                <div>
                  <p className="muted small">{label('stages.preset')}</p>
                  {presetPoints.length === 0 ? (
                    <p className="muted small">{label('stages.empty')}</p>
                  ) : (
                    <ul className="muted small">
                      {presetPoints.map((id) => (
                        <li key={id}>{pointLabel(id)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
              {s.activePoints.length > 0 ? (
                <p className="muted small">{t(`${base}.stages.active` as MessageKey, { points: s.activePoints.map(pointLabel).join(', ') })}</p>
              ) : null}
            </SettingsGroup>
          </SettingsGroup>
        ) : null}
        <StatusLine status={r.status} />
      </LoadGate>
    </div>
  );
}
