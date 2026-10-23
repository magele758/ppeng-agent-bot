'use client';

import { useMemo } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { parseIntInRange } from '@/lib/settings-fields';
import { ConfigGroup, FieldLabel } from './ConfigGroup';
import { ExperimentRow } from './ui';
import {
  LoadGate,
  SaveBar,
  SelectField,
  SourceBadge,
  StatusLine,
  TextField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

export type CompactPolicy = 'keep_recent' | 'after_any_assistant' | 'after_text_assistant';

interface CompactSettings {
  policy: CompactPolicy;
  keepRecent: number;
  enabled?: boolean;
  updatedAt: string;
}

interface CompactEffective {
  policy: CompactPolicy;
  keepRecent: number;
  enabled: boolean;
  source: string;
}

const COMPACT_PATH = '/api/compact/settings';
const POLICIES: readonly CompactPolicy[] = ['keep_recent', 'after_text_assistant', 'after_any_assistant'];
const DEFAULTS = { policy: 'keep_recent', keepRecent: 3 } as const;
const KEEP_RANGE = { min: 0, max: 50 } as const;
const EMPTY_FORM = { keepRecent: '' };

function SessionStatsLine({ stats }: { stats?: { collapsed: number; charsSaved: number } | null }) {
  const { t } = useI18n();
  if (!stats) return null;
  return (
    <p className="muted compact-session-stats" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
      {t('more.compactSessionStats', { collapsed: stats.collapsed, chars: stats.charsSaved })}
    </p>
  );
}

/** 对话输入框「会话设置」里的紧凑版本（沿用原有文案，由 PlayPanel 使用） */
function CompactInline({ sessionStats }: { sessionStats?: { collapsed: number; charsSaved: number } | null }) {
  const { t } = useI18n();
  const r = useSettingsResource<CompactSettings, CompactEffective>(COMPACT_PATH);
  const settings = r.settings;
  const keepSaved = settings ? String(settings.keepRecent) : '';
  const form = useDraftForm(useMemo(() => ({ keepRecent: keepSaved }), [keepSaved]), EMPTY_FORM);

  if (!settings) return <span className="muted">{r.loadError ?? t('common.loading')}</span>;

  const commitKeep = () => {
    const parsed = parseIntInRange(form.draft.keepRecent, KEEP_RANGE.min, KEEP_RANGE.max);
    if (!parsed.ok) {
      r.setStatus({ kind: 'err', text: t('more.compactKeepRecentInvalid') });
      return;
    }
    if (parsed.value === settings.keepRecent) return;
    void r.save({ keepRecent: parsed.value });
  };

  const policy = r.effective?.policy ?? settings.policy;
  return (
    <ConfigGroup title={t('more.compactGroupTitle')} tip={t('more.compactGroupTip')}>
      <label className="field field--inline">
        <FieldLabel tip={t('more.compactCollapseTip')}>{t('more.compactCollapseLabel')}</FieldLabel>
        <select
          disabled={r.busy}
          value={settings.policy}
          aria-label={t('more.compactPolicyAria')}
          onChange={(e) => void r.save({ policy: e.target.value as CompactPolicy })}
        >
          <option value="keep_recent">{t('more.compactPolicyKeepRecent')}</option>
          <option value="after_text_assistant">{t('more.compactPolicyAfterText')}</option>
          <option value="after_any_assistant">{t('more.compactPolicyAfterAny')}</option>
        </select>
      </label>
      {settings.policy === 'keep_recent' ? (
        <label className="field field--inline">
          <span>{t('more.compactKeepRecent')}</span>
          <input
            type="number"
            min={KEEP_RANGE.min}
            max={KEEP_RANGE.max}
            step={1}
            disabled={r.busy}
            value={form.draft.keepRecent}
            aria-label={t('more.compactKeepRecent')}
            onChange={(e) => form.set('keepRecent', e.target.value)}
            onBlur={() => commitKeep()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </label>
      ) : null}
      <p className="muted compact-effective-policy" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
        {t('more.effectivePrefix')}policy={policy}
        {policy === 'keep_recent' ? ` · keepRecent=${r.effective?.keepRecent ?? settings.keepRecent}` : ''}
        {r.effective && !r.effective.enabled ? t('more.compactMicroOff') : ''}
      </p>
      <SessionStatsLine stats={sessionStats} />
      {r.status?.kind === 'ok' ? (
        <p className="muted" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
          {t('more.savedNoRestart')}
        </p>
      ) : null}
      {r.status?.kind === 'err' ? (
        <p style={{ color: 'var(--danger, #c44)', fontSize: '0.75rem', margin: '4px 0 0' }}>{r.status.text}</p>
      ) : null}
    </ConfigGroup>
  );
}

function CompactSettingsPanel({ sessionStats }: { sessionStats?: { collapsed: number; charsSaved: number } | null }) {
  const { t } = useI18n();
  const r = useSettingsResource<CompactSettings, CompactEffective>(COMPACT_PATH);
  const s = r.settings;
  const base = 'settingsEntries.compact';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const keepSaved = s ? String(s.keepRecent) : '';
  const form = useDraftForm(useMemo(() => ({ keepRecent: keepSaved }), [keepSaved]), EMPTY_FORM);
  const rangeError = () => t('settingsEntries.common.invalidRange', KEEP_RANGE);

  const policyOptions = POLICIES.map((v) => ({ value: v, label: label(`options.policy.${v}.label`) }));

  const submit = async () => {
    const parsed = parseIntInRange(form.draft.keepRecent, KEEP_RANGE.min, KEEP_RANGE.max);
    if (!parsed.ok) {
      form.setError('keepRecent', rangeError());
      return;
    }
    await r.save({ keepRecent: parsed.value });
  };

  const armed = s ? (typeof s.enabled === 'boolean' ? s.enabled : Boolean(r.effective?.enabled)) : false;

  return (
    <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {s ? (
        <ExperimentRow
          id="card-compact"
          switchId="compact"
          title={label('title')}
          description={label('desc')}
          on={armed}
          busy={r.busy}
          onChange={(enabled) => void r.save({ enabled })}
        >
          <>
            <SelectField
              id="field-compactPolicy"
              label={label('fields.policy.label')}
              hint={`${label('fields.policy.hint')} ${label(`options.policy.${s.policy}.desc`)}`}
              value={s.policy}
              options={policyOptions}
              disabled={r.busy}
              defaultText={label(`options.policy.${DEFAULTS.policy}.label`)}
              isDefault={s.policy === DEFAULTS.policy}
              onRestore={() => void r.save({ policy: DEFAULTS.policy })}
              onChange={(policy) => void r.save({ policy })}
            />
            <TextField
              id="field-compactKeepRecent"
              type="number"
              inputMode="numeric"
              label={label('fields.keepRecent.label')}
              hint={label('fields.keepRecent.hint')}
              value={form.draft.keepRecent}
              disabled={r.busy || s.policy !== 'keep_recent'}
              error={form.errors.keepRecent}
              defaultText={String(DEFAULTS.keepRecent)}
              isDefault={form.draft.keepRecent === String(DEFAULTS.keepRecent)}
              onRestore={() => form.set('keepRecent', String(DEFAULTS.keepRecent))}
              onChange={(v) => form.set('keepRecent', v)}
              onBlur={() => {
                if (!parseIntInRange(form.draft.keepRecent, KEEP_RANGE.min, KEEP_RANGE.max).ok) {
                  form.setError('keepRecent', rangeError());
                }
              }}
            />
            <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submit()} onReset={form.reset} />
            <SessionStatsLine stats={sessionStats} />
          </>
        </ExperimentRow>
      ) : null}
      <StatusLine status={r.status} />
      {r.effective ? <SourceBadge source={r.effective.source} /> : null}
    </LoadGate>
  );
}

export function CompactSettingsCard({
  compact = false,
  sessionStats
}: {
  compact?: boolean;
  sessionStats?: { collapsed: number; charsSaved: number } | null;
}) {
  return compact ? <CompactInline sessionStats={sessionStats} /> : <CompactSettingsPanel sessionStats={sessionStats} />;
}
