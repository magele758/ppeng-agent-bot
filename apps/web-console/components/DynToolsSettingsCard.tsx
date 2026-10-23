'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { buildPatch, parseIntInRange } from '@/lib/settings-fields';
import { EmptyState, ExperimentRow, SettingsGroup } from './ui';
import {
  LoadGate,
  SaveBar,
  SourceBadge,
  StatusLine,
  TextField,
  ToggleField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

interface DynToolSettings {
  enabled: boolean;
  allowPropose: boolean;
  allowSave: boolean;
  allowProjectPromote: boolean;
  hydrateTopK: number;
  unusedSuggestTurns: number;
}

interface DynToolEffective {
  enabled: boolean;
  source: string;
}

interface DynToolRow {
  name: string;
  description: string;
  scope: string;
  status: string;
}

const DEFAULTS = {
  enabled: false,
  allowSave: true,
  allowPropose: true,
  allowProjectPromote: true,
  hydrateTopK: 8,
  unusedSuggestTurns: 20
} as const;
const TOP_K_RANGE = { min: 1, max: 20 } as const;
const UNUSED_RANGE = { min: 1, max: 10000 } as const;
const TUNING_KEYS = ['hydrateTopK', 'unusedSuggestTurns'] as const;
const EMPTY_TUNING = { hydrateTopK: '', unusedSuggestTurns: '' };

export function DynToolsSettingsCard({ sessionId }: { sessionId?: string }) {
  const { t } = useI18n();
  const r = useSettingsResource<DynToolSettings, DynToolEffective>('/api/dyn-tools/settings');
  const s = r.settings;
  const base = 'settingsEntries.dynTools';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const onOff = (v: boolean) => t(v ? 'settingsEntries.common.on' : 'settingsEntries.common.off');

  const saved = useMemo(
    () => (s ? { hydrateTopK: String(s.hydrateTopK), unusedSuggestTurns: String(s.unusedSuggestTurns) } : null),
    [s]
  );
  const form = useDraftForm(saved, EMPTY_TUNING);

  const [tools, setTools] = useState<DynToolRow[]>([]);
  const sessionRun = r.run;

  const loadTools = useCallback(async () => {
    if (!sessionId) {
      setTools([]);
      return;
    }
    await sessionRun(async () => {
      const data = (await api(`/api/sessions/${sessionId}/dyn-tools`)) as { tools?: DynToolRow[] };
      setTools(Array.isArray(data.tools) ? data.tools : []);
    });
  }, [sessionId, sessionRun]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  const act = async (name: string, action: 'retire' | 'promote', targetScope?: string) => {
    if (!sessionId) return;
    await r.run(
      async () => {
        const path = `/api/sessions/${sessionId}/dyn-tools/${encodeURIComponent(name)}/${action}`;
        const data = (await api(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: action === 'promote' ? JSON.stringify({ targetScope }) : '{}'
        })) as { pending?: boolean };
        await loadTools();
        return data;
      },
      (data) => (data.pending ? label('session.promotePending') : t('settingsEntries.common.saved'))
    );
  };

  const submitTuning = async () => {
    if (!saved) return;
    const topK = parseIntInRange(form.draft.hydrateTopK, TOP_K_RANGE.min, TOP_K_RANGE.max);
    const unused = parseIntInRange(form.draft.unusedSuggestTurns, UNUSED_RANGE.min, UNUSED_RANGE.max);
    if (!topK.ok || !unused.ok) {
      form.setErrors({
        hydrateTopK: topK.ok ? undefined : t('settingsEntries.common.invalidRange', TOP_K_RANGE),
        unusedSuggestTurns: unused.ok ? undefined : t('settingsEntries.common.invalidRange', UNUSED_RANGE)
      });
      return;
    }
    const patch = buildPatch(form.draft, saved, TUNING_KEYS) as Record<string, unknown>;
    if ('hydrateTopK' in patch) patch.hydrateTopK = topK.value;
    if ('unusedSuggestTurns' in patch) patch.unusedSuggestTurns = unused.value;
    await r.save(patch);
  };

  const toggle = (
    key: 'allowSave' | 'allowPropose' | 'allowProjectPromote',
    id: string,
    field: 'allowSave' | 'allowPropose' | 'allowPromote'
  ) =>
    s ? (
      <ToggleField
        id={id}
        label={label(`fields.${field}.label`)}
        hint={label(`fields.${field}.hint`)}
        checked={s[key]}
        disabled={r.busy || !s.enabled}
        defaultText={onOff(DEFAULTS[key])}
        isDefault={s[key] === DEFAULTS[key]}
        onRestore={() => void r.save({ [key]: DEFAULTS[key] })}
        onChange={(v) => void r.save({ [key]: v })}
      />
    ) : null;

  return (
    <div className="settings-stack" id="card-dyn-tools">
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <ExperimentRow
            switchId="dynTools"
            title={label('title')}
            description={label('desc')}
            on={s.enabled}
            busy={r.busy}
            onChange={(enabled) => void r.save({ enabled })}
          >
            <>
              {toggle('allowSave', 'field-dynToolsAllowSave', 'allowSave')}
              {toggle('allowPropose', 'field-dynToolsAllowPropose', 'allowPropose')}
              {toggle('allowProjectPromote', 'field-dynToolsAllowPromote', 'allowPromote')}
              <SettingsGroup
          id="card-dyn-tools-tuning"
          title={label('tuning.title')}
          description={label('tuning.desc')}
          collapsible
          defaultOpen={false}
        >
          <TextField
            id="field-dynToolsTopK"
            type="number"
            inputMode="numeric"
            label={label('fields.hydrateTopK.label')}
            hint={label('fields.hydrateTopK.hint')}
            value={form.draft.hydrateTopK}
            disabled={r.busy || !s.enabled}
            error={form.errors.hydrateTopK}
            defaultText={String(DEFAULTS.hydrateTopK)}
            isDefault={form.draft.hydrateTopK === String(DEFAULTS.hydrateTopK)}
            onRestore={() => form.set('hydrateTopK', String(DEFAULTS.hydrateTopK))}
            onChange={(v) => form.set('hydrateTopK', v)}
          />
          <TextField
            id="field-dynToolsUnusedTurns"
            type="number"
            inputMode="numeric"
            label={label('fields.unusedTurns.label')}
            hint={label('fields.unusedTurns.hint')}
            value={form.draft.unusedSuggestTurns}
            disabled={r.busy || !s.enabled}
            error={form.errors.unusedSuggestTurns}
            defaultText={String(DEFAULTS.unusedSuggestTurns)}
            isDefault={form.draft.unusedSuggestTurns === String(DEFAULTS.unusedSuggestTurns)}
            onRestore={() => form.set('unusedSuggestTurns', String(DEFAULTS.unusedSuggestTurns))}
            onChange={(v) => form.set('unusedSuggestTurns', v)}
          />
          <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submitTuning()} onReset={form.reset} />
        </SettingsGroup>
        <SettingsGroup id="card-dyn-tools-session" title={label('session.title')} description={label('session.desc')}>
        {!sessionId ? (
          <EmptyState title={label('session.noSession')} />
        ) : tools.length === 0 ? (
          <EmptyState title={label('session.empty')} />
        ) : (
          tools.map((row) => (
            <div key={row.name} className="settings-list-item">
              <strong>{row.name}</strong>
              <span className="muted">{t(`${base}.session.status` as MessageKey, { status: row.status, scope: row.scope })}</span>
              {row.description ? <span className="muted">{row.description}</span> : null}
              {row.status !== 'retired' ? (
                <div className="settings-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void act(row.name, 'retire')}>
                    {label('session.retire')}
                  </button>
                  {row.scope === 'session.scratch' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={r.busy}
                      onClick={() => void act(row.name, 'promote', 'session.long')}
                    >
                      {label('session.promoteLong')}
                    </button>
                  ) : null}
                  {row.scope !== 'project.memory' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={r.busy || !s?.allowProjectPromote}
                      onClick={() => void act(row.name, 'promote', 'project.memory')}
                    >
                      {label('session.promoteProject')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))
        )}
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
