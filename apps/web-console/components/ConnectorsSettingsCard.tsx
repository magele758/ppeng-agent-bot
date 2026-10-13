'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { LoadGate } from './sections/settings/categories/kit/fields';
import { SettingsGroup } from './ui';

interface ConnectorRow {
  id: string;
  title: string;
  granted: boolean;
}

export function ConnectorsSettingsCard() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ConnectorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const data = (await api('/api/connectors')) as { connectors?: ConnectorRow[] };
      const list = Array.isArray(data.connectors) ? data.connectors : [];
      setRows(
        list.map((row) => ({
          id: String(row.id),
          title: String(row.title || row.id),
          granted: row.granted === true
        }))
      );
    } catch {
      setRows(null);
      setError(t('settingsEntries.connectors.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="settings-stack" id="card-connectors">
      <SettingsGroup title={t('settingsEntries.connectors.title')} description={t('settingsEntries.connectors.desc')}>
        <LoadGate ready={rows !== null} error={error} onRetry={() => void reload()}>
          {rows && rows.length === 0 ? <p>{t('settingsEntries.connectors.empty')}</p> : null}
          {rows?.map((row) => (
            <p key={row.id}>
              {row.title} · {row.granted ? t('settingsEntries.connectors.granted') : t('settingsEntries.connectors.notGranted')}
            </p>
          ))}
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()}>
              {t('settingsEntries.common.refresh')}
            </button>
          </div>
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}
