'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  KIND_FIELDS,
  SECRET_FORM_FIELDS,
  VAULT_KINDS,
  emptyForm,
  entryPayload,
  entrySubtitle,
  fillRefsText,
  type VaultEntry,
  type VaultForm,
  type VaultFormField,
  type VaultKind
} from '@/lib/user-vault';
import { SettingsGroup } from './ui';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { LoadGate, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';

const JSON_HEADERS = { 'content-type': 'application/json' };

function EntryRow({ entry, onDelete }: { entry: VaultEntry; onDelete: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const instruction = t('settingsEntries.userVault.fillInstruction', {
    label: entry.label,
    refs: fillRefsText(entry)
  });
  return (
    <li className="settings-vault-entry" data-testid={`user-vault-entry-${entry.id}`}>
      <strong>{entry.label}</strong> <span>{t(`settingsEntries.userVault.kinds.${entry.kind}`)}</span>{' '}
      <span>{entrySubtitle(entry)}</span>
      <div className="settings-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
          {t('settingsEntries.userVault.pickToFill')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(entry.id)}>
          {t('settingsEntries.userVault.delete')}
        </button>
      </div>
      {open ? <FillInstruction text={instruction} /> : null}
    </li>
  );
}

function FillInstruction({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true));
  };
  return (
    <div className="settings-vault-instruction">
      <p>{t('settingsEntries.userVault.pickHint')}</p>
      <code data-testid="user-vault-fill-instruction">{text}</code>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        {copied ? t('settingsEntries.userVault.copied') : t('settingsEntries.userVault.copy')}
      </button>
    </div>
  );
}

function FormInput({ form, field, onChange }: { form: VaultForm; field: VaultFormField; onChange: (field: VaultFormField, value: string) => void }) {
  const { t } = useI18n();
  const secret = SECRET_FORM_FIELDS.includes(field);
  return (
    <label className="settings-vault-field">
      <span>{t(`settingsEntries.userVault.fields.${field}`)}</span>
      <input
        type={secret ? 'password' : 'text'}
        autoComplete={secret ? 'new-password' : 'off'}
        value={form[field]}
        onChange={(e) => onChange(field, e.target.value)}
      />
    </label>
  );
}

function EntryForm({ onSaved, onError }: { onSaved: () => void; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<VaultForm>(emptyForm('login'));
  const setField = (field: VaultFormField, value: string) => setForm({ ...form, [field]: value });
  const setKind = (kind: VaultKind) => setForm({ ...emptyForm(kind), label: form.label });
  const submit = () => {
    api('/api/user-vault/entries', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(entryPayload(form)) })
      .then(() => {
        setForm(emptyForm(form.kind));
        onSaved();
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <form
      className="settings-vault-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="settings-vault-field">
        <span>{t('settingsEntries.userVault.kind')}</span>
        <select value={form.kind} onChange={(e) => setKind(e.target.value as VaultKind)}>
          {VAULT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`settingsEntries.userVault.kinds.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {(['label', ...KIND_FIELDS[form.kind]] as VaultFormField[]).map((field) => (
        <FormInput key={field} form={form} field={field} onChange={setField} />
      ))}
      <button type="submit" className="btn btn-sm" disabled={!form.label.trim()}>
        {t('settingsEntries.userVault.add')}
      </button>
    </form>
  );
}

export function UserVaultSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<{ enabled: boolean }>('/api/user-vault/settings');
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const data = (await api('/api/user-vault')) as { entries?: VaultEntry[] };
      setEntries(data.entries ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const remove = (id: string) => {
    api(`/api/user-vault/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(reload, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e))
    );
  };
  return (
    <div id="card-userVault" className="settings-stack">
      <SettingsGroup title={t('settingsEntries.userVault.title')} description={t('settingsEntries.userVault.desc')}>
        <LoadGate ready={entries !== null && r.settings !== null} error={error ?? r.loadError} onRetry={() => void reload()}>
          {r.settings ? (
            <ToggleField
              id="field-userVaultEnabled"
              label={t('settingsEntries.userVault.enabled')}
              hint={t('settingsEntries.userVault.hint')}
              checked={r.settings.enabled}
              disabled={r.busy}
              defaultText={t('settingsEntries.common.off')}
              isDefault={!r.settings.enabled}
              onRestore={() => void r.save({ enabled: false })}
              onChange={(enabled) => void r.save({ enabled })}
            />
          ) : null}
          <ul className="settings-vault-list">
            {(entries ?? []).map((entry) => (
              <EntryRow key={entry.id} entry={entry} onDelete={remove} />
            ))}
          </ul>
          <EntryForm onSaved={() => void reload()} onError={setError} />
          <StatusLine status={r.status} />
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}
