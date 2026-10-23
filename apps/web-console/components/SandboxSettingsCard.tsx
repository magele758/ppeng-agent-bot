'use client';

import { useMemo } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { buildPatch, parseIntInRange } from '@/lib/settings-fields';
import { ExperimentRow, SettingsGroup } from './ui';
import {
  LoadGate,
  RiskNotice,
  SaveBar,
  SelectField,
  SourceBadge,
  StatusLine,
  TextField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

type SandboxMode = 'auto' | 'direct' | 'os' | 'container' | 'cloudflare-computer';
type CfBackend = '' | 'worker-shell' | 'container-shell';

interface SandboxSettings {
  mode: SandboxMode;
  cfEndpoint: string;
  cfWorkspaceName: string;
  cfAccountId: string;
  cfTimeoutMs: number;
  cfBackend: CfBackend;
  cfTokenSecretName: string;
  cfEnabled?: boolean;
}

interface SandboxEffective {
  mode: SandboxMode;
  source: string;
  cfEndpoint?: string;
  tokenPresent: boolean;
  tokenSource: string;
}

function cloudflareOn(settings: SandboxSettings, effectiveEndpoint?: string): boolean {
  if (settings.cfEnabled === false) return false;
  if (settings.cfEnabled === true) return true;
  return settings.cfEndpoint.length > 0 || Boolean(effectiveEndpoint);
}

const SANDBOX_PATH = '/api/sandbox/settings';
const MODES: readonly SandboxMode[] = ['auto', 'os', 'direct', 'container', 'cloudflare-computer'];
const BACKENDS: readonly CfBackend[] = ['', 'worker-shell', 'container-shell'];
const DEFAULT_MODE: SandboxMode = 'auto';
const CF_DEFAULTS = { cfEndpoint: '', cfWorkspaceName: 'default', cfAccountId: '', cfTimeoutMs: '60000', cfBackend: '', cfTokenSecretName: '' };
const TIMEOUT_RANGE = { min: 1000, max: 600000 } as const;
const CF_KEYS = ['cfEndpoint', 'cfWorkspaceName', 'cfAccountId', 'cfTimeoutMs', 'cfBackend', 'cfTokenSecretName'] as const;
const EMPTY_CF_FORM = { ...CF_DEFAULTS };

export function SandboxSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<SandboxSettings, SandboxEffective>(SANDBOX_PATH);
  const s = r.settings;
  const base = 'settingsEntries.sandbox';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const mode = s?.mode ?? DEFAULT_MODE;
  const modeOptions = MODES.map((v) => ({ value: v, label: label(`options.mode.${v}.label`) }));

  return (
    <SettingsGroup id="card-sandbox" title={label('title')} description={label('desc')}>
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <>
            <SelectField
              id="field-sandboxMode"
              label={label('fields.mode.label')}
              hint={`${label('fields.mode.hint')} ${label(`options.mode.${mode}.desc`)}`}
              value={mode}
              options={modeOptions}
              disabled={r.busy}
              defaultText={label(`options.mode.${DEFAULT_MODE}.label`)}
              isDefault={mode === DEFAULT_MODE}
              onRestore={() => void r.save({ mode: DEFAULT_MODE })}
              onChange={(next) => void r.save({ mode: next })}
            />
            {mode === 'direct' ? <RiskNotice>{label('risk.direct')}</RiskNotice> : null}
            {mode === 'container' ? <RiskNotice>{label('risk.container')}</RiskNotice> : null}
          </>
        ) : null}
        <StatusLine status={r.status} />
        {r.effective ? <SourceBadge source={r.effective.source} /> : null}
      </LoadGate>
    </SettingsGroup>
  );
}

export function SandboxCloudflareSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<SandboxSettings, SandboxEffective>(SANDBOX_PATH);
  const s = r.settings;
  const base = 'settingsEntries.sandboxCloudflare';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);

  const saved = useMemo(
    () =>
      s
        ? {
            cfEndpoint: s.cfEndpoint,
            cfWorkspaceName: s.cfWorkspaceName,
            cfAccountId: s.cfAccountId,
            cfTimeoutMs: String(s.cfTimeoutMs),
            cfBackend: s.cfBackend,
            cfTokenSecretName: s.cfTokenSecretName
          }
        : null,
    [s]
  );
  const form = useDraftForm(saved, EMPTY_CF_FORM);
  const rangeError = () => t('settingsEntries.common.invalidRange', TIMEOUT_RANGE);
  const backendOptions = BACKENDS.map((v) => ({ value: v, label: label(`options.backend.${v === '' ? 'none' : v}`) }));
  const tokenName = form.draft.cfTokenSecretName.trim() || 'CLOUDFLARE_COMPUTER_TOKEN';

  const submit = async () => {
    if (!saved) return;
    const timeout = parseIntInRange(form.draft.cfTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max);
    if (!timeout.ok) {
      form.setError('cfTimeoutMs', rangeError());
      return;
    }
    const patch = buildPatch(form.draft, saved, CF_KEYS) as Record<string, unknown>;
    if ('cfTimeoutMs' in patch) patch.cfTimeoutMs = timeout.value;
    await r.save(patch);
  };

  const field = (key: (typeof CF_KEYS)[number]) => ({
    value: form.draft[key] as string,
    error: form.errors[key],
    disabled: r.busy,
    isDefault: form.draft[key] === CF_DEFAULTS[key],
    onRestore: () => form.set(key, CF_DEFAULTS[key]),
    onChange: (v: string) => form.set(key, v)
  });

  return (
    <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {s ? (
        <ExperimentRow
          id="card-sandbox-cloudflare"
          switchId="sandboxCloudflare"
          title={label('title')}
          description={label('desc')}
          on={cloudflareOn(s, r.effective?.cfEndpoint)}
          busy={r.busy}
          onChange={(cfEnabled) => void r.save({ cfEnabled })}
        >
          <>
            <TextField
              id="field-cfEndpoint"
              type="url"
              label={label('fields.endpoint.label')}
              hint={label('fields.endpoint.hint')}
              placeholder="https://your-computer.workers.dev"
              defaultText={t('settingsEntries.common.none')}
              {...field('cfEndpoint')}
            />
            <TextField
              id="field-cfWorkspace"
              label={label('fields.workspace.label')}
              hint={label('fields.workspace.hint')}
              defaultText={CF_DEFAULTS.cfWorkspaceName}
              {...field('cfWorkspaceName')}
            />
            <TextField
              id="field-cfAccount"
              label={label('fields.account.label')}
              hint={label('fields.account.hint')}
              defaultText={t('settingsEntries.common.none')}
              {...field('cfAccountId')}
            />
            <TextField
              id="field-cfTimeout"
              type="number"
              inputMode="numeric"
              label={label('fields.timeout.label')}
              hint={label('fields.timeout.hint')}
              defaultText={CF_DEFAULTS.cfTimeoutMs}
              {...field('cfTimeoutMs')}
              onBlur={() => {
                if (!parseIntInRange(form.draft.cfTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max).ok) {
                  form.setError('cfTimeoutMs', rangeError());
                }
              }}
            />
            <SelectField
              id="field-cfBackend"
              label={label('fields.backend.label')}
              hint={label('fields.backend.hint')}
              value={form.draft.cfBackend as CfBackend}
              options={backendOptions}
              disabled={r.busy}
              defaultText={label('options.backend.none')}
              isDefault={form.draft.cfBackend === CF_DEFAULTS.cfBackend}
              onRestore={() => form.set('cfBackend', CF_DEFAULTS.cfBackend)}
              onChange={(v) => form.set('cfBackend', v)}
            />
            <TextField
              id="field-cfTokenName"
              label={label('fields.tokenName.label')}
              hint={`${label('fields.tokenName.hint')} ${
                r.effective?.tokenPresent
                  ? t(`${base}.token.found` as MessageKey, { source: r.effective.tokenSource })
                  : t(`${base}.token.missing` as MessageKey, { name: tokenName })
              }`}
              placeholder="CLOUDFLARE_COMPUTER_TOKEN"
              defaultText={t('settingsEntries.common.none')}
              {...field('cfTokenSecretName')}
            />
            <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submit()} onReset={form.reset} />
          </>
        </ExperimentRow>
      ) : null}
      <StatusLine status={r.status} />
    </LoadGate>
  );
}
