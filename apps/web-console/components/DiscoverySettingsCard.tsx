'use client';

import { useMemo } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { buildPatch, formatListInput, parseListInput } from '@/lib/settings-fields';
import { ExperimentRow, SettingsGroup } from './ui';
import {
  LoadGate,
  RiskNotice,
  SaveBar,
  SourceBadge,
  StatusLine,
  TextField,
  ToggleField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

interface DiscoverySettings {
  enabled: boolean;
  tailscaleEnabled: boolean;
  activeScanEnabled: boolean;
  hostAllowlist: string[];
  cidrAllowlist: string[];
}

interface DiscoveryEffective {
  enabled: boolean;
  tailscaleEnabled: boolean;
  source: string;
}

const DEFAULTS = { enabled: true, tailscaleEnabled: false, activeScanEnabled: false } as const;
const LIST_KEYS = ['hostAllowlist', 'cidrAllowlist'] as const;
const EMPTY_LISTS = { hostAllowlist: '', cidrAllowlist: '' };

export function DiscoverySettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<DiscoverySettings, DiscoveryEffective>('/api/capabilities/settings');
  const s = r.settings;
  const base = 'settingsEntries.discovery';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const onOff = (v: boolean) => t(v ? 'settingsEntries.common.on' : 'settingsEntries.common.off');

  const saved = useMemo(
    () =>
      s
        ? { hostAllowlist: formatListInput(s.hostAllowlist), cidrAllowlist: formatListInput(s.cidrAllowlist) }
        : null,
    [s]
  );
  const form = useDraftForm(saved, EMPTY_LISTS);

  const submitLists = async () => {
    if (!saved) return;
    const patch = buildPatch(form.draft, saved, LIST_KEYS) as Record<string, unknown>;
    for (const k of LIST_KEYS) if (k in patch) patch[k] = parseListInput(form.draft[k]);
    await r.save(patch);
  };

  const probe = () =>
    r.run(
      async () => {
        const data = (await api('/api/capabilities/probe/tailscale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })) as { count?: number; source?: string };
        await r.reload();
        return data;
      },
      (data) => t(`${base}.probeDone` as MessageKey, { count: data.count ?? 0, source: data.source ?? '—' })
    );

  const toggle = (
    key: keyof typeof DEFAULTS,
    id: string,
    field: 'enabled' | 'tailscale' | 'activeScan',
    dependsOnEnabled: boolean
  ) =>
    s ? (
      <ToggleField
        id={id}
        label={label(`fields.${field}.label`)}
        hint={label(`fields.${field}.hint`)}
        checked={s[key]}
        disabled={r.busy || (dependsOnEnabled && !s.enabled)}
        defaultText={onOff(DEFAULTS[key])}
        isDefault={s[key] === DEFAULTS[key]}
        onRestore={() => void r.save({ [key]: DEFAULTS[key] })}
        onChange={(v) => void r.save({ [key]: v })}
      />
    ) : null;

  return (
    <div className="settings-stack" id="card-discovery">
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <ExperimentRow
            switchId="discovery"
            title={label('title')}
            description={label('desc')}
            on={s.enabled}
            busy={r.busy}
            onChange={(enabled) => void r.save({ enabled })}
          >
            <>
              {toggle('tailscaleEnabled', 'field-discoveryTailscale', 'tailscale', true)}
              {toggle('activeScanEnabled', 'field-discoveryActiveScan', 'activeScan', true)}
              {s.activeScanEnabled ? <RiskNotice>{label('risk.activeScan')}</RiskNotice> : null}
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={r.busy || !r.effective?.tailscaleEnabled}
                  onClick={() => void probe()}
                >
                  {label('probe')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void r.reload()}>
                  {t('settingsEntries.common.refresh')}
                </button>
              </div>
              <SettingsGroup
          id="card-discovery-allowlist"
          title={label('allowlist.title')}
          description={label('allowlist.desc')}
        >
          <TextField
            id="field-discoveryHosts"
            label={label('fields.hosts.label')}
            hint={label('fields.hosts.hint')}
            placeholder="api.example.com"
            value={form.draft.hostAllowlist}
            disabled={r.busy}
            defaultText={t('settingsEntries.common.none')}
            isDefault={form.draft.hostAllowlist === ''}
            onRestore={() => form.set('hostAllowlist', '')}
            onChange={(v) => form.set('hostAllowlist', v)}
          />
          <TextField
            id="field-discoveryCidrs"
            label={label('fields.cidrs.label')}
            hint={label('fields.cidrs.hint')}
            placeholder="100.64.0.0/10, 10.0.0.0/8"
            value={form.draft.cidrAllowlist}
            disabled={r.busy}
            defaultText={t('settingsEntries.common.none')}
            isDefault={form.draft.cidrAllowlist === ''}
            onRestore={() => form.set('cidrAllowlist', '')}
            onChange={(v) => form.set('cidrAllowlist', v)}
          />
          <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submitLists()} onReset={form.reset} />
        </SettingsGroup>
            </>
          </ExperimentRow>
        ) : null}
        <StatusLine status={r.status} />
        {r.effective ? <SourceBadge source={r.effective.source} /> : null}
      </LoadGate>
    </div>
  );
}
