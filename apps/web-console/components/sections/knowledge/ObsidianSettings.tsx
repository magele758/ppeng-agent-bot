'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type I18nContextValue } from '@/lib/i18n';
import { SettingsGroup } from '../../ui';
import styles from './knowledge.module.css';

interface VaultSettings { configuredPath: string; destination: string }
const endpoint = '/api/obsidian/settings';
type Translate = I18nContextValue['t'];
type VaultStatusCode = 'saved' | 'invalid' | 'failed';

function VaultStatus({ settings, status, t }: {
  settings: VaultSettings | undefined;
  status: VaultStatusCode | undefined;
  t: Translate;
}) {
  return <>
    {settings ? <p>{t('knowledge.vault.destination')} <code>{settings.destination || t('knowledge.vault.missing')}</code></p> : null}
    {status ? <p role="status">{t(`knowledge.vault.${status}`)}</p> : null}
  </>;
}

export function ObsidianSettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<VaultSettings>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<VaultStatusCode>();
  useEffect(() => {
    let active = true;
    api(endpoint).then(result => {
      if (!active) return;
      const value = result as VaultSettings;
      setSettings(value);
      setPath(value.configuredPath);
    }).catch(() => { if (active) setStatus('failed'); });
    return () => { active = false; };
  }, []);
  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      const value = await api(endpoint, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      }) as VaultSettings;
      setSettings(value);
      setPath(value.configuredPath);
      setStatus('saved');
    } catch (err) {
      setStatus(String(err).includes('obsidian_invalid_path') ? 'invalid' : 'failed');
    } finally { setBusy(false); }
  }
  const locked = !settings || busy;
  return <SettingsGroup title={t('knowledge.vault.title')} description={t('knowledge.vault.help')}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className={styles.field}>{t('knowledge.vault.path')}
        <input className={styles.input} value={path} onChange={event => setPath(event.target.value)}
          disabled={locked} placeholder={t('knowledge.vault.auto')} />
      </label>
      <button type="submit" className="btn btn-secondary btn-sm" disabled={locked}>{t('knowledge.vault.save')}</button>
    </form>
    <VaultStatus settings={settings} status={status} t={t} />
  </SettingsGroup>;
}
