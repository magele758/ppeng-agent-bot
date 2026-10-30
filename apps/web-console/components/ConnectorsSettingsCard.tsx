'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  connectorViews,
  defaultGrantName,
  grantReferenceBody,
  secretNames,
  type ConnectorAuthState,
  type ConnectorView,
  type SecretName
} from '@/lib/connectors-grant';
import { useI18n } from '@/lib/i18n';
import { LoadGate } from './sections/settings/categories/kit/fields';
import { SettingsGroup } from './ui';

export async function postConnectorGrant(
  row: ConnectorView,
  pickedName: string | undefined,
  post: (path: string, body: { secretEnv?: string; credRef?: string }) => Promise<unknown> = (path, body) =>
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
): Promise<void> {
  const body = grantReferenceBody(row, pickedName);
  await post(`/api/connectors/${encodeURIComponent(row.id)}/grant`, body);
}

const STATE_ORDER: ConnectorAuthState[] = ['needsAuth', 'needsGrant', 'granted'];

function stateKey(state: ConnectorAuthState): `settingsEntries.connectors.states.${ConnectorAuthState}` {
  return `settingsEntries.connectors.states.${state}`;
}

export function ConnectorAuthList({
  rows,
  secrets,
  picks,
  busyId,
  rowError,
  onPick,
  onGrant,
  onRevoke,
  onRefresh
}: {
  rows: ConnectorView[];
  secrets: SecretName[];
  picks: Record<string, string>;
  busyId: string | null;
  rowError: string | null;
  onPick: (id: string, name: string) => void;
  onGrant: (row: ConnectorView) => void;
  onRevoke: (row: ConnectorView) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {rows.length === 0 ? <p>{t('settingsEntries.connectors.empty')}</p> : null}
      <ol className="connector-auth-states" aria-label={t('settingsEntries.connectors.stateMachine')}>
        {STATE_ORDER.map((state) => (
          <li key={state} data-state={state}>
            {t(stateKey(state))}
          </li>
        ))}
      </ol>
      {rows.map((row) => {
        const selected = picks[row.id] ?? defaultGrantName(row, secrets);
        const canGrant = row.authState !== 'granted';
        const needsName = row.authState === 'needsAuth';
        return (
          <div key={row.id} className="connector-row" data-connector-id={row.id} data-auth-state={row.authState}>
            <p>
              {row.title} · <span data-auth-label={row.authState}>{t(stateKey(row.authState))}</span>
            </p>
            {row.secretEnv ? (
              <p>
                {t('settingsEntries.connectors.secretRef')}: {row.secretEnv}
              </p>
            ) : null}
            {row.credRef ? (
              <p>
                {t('settingsEntries.connectors.credRef')}: {row.credRef}
              </p>
            ) : null}
            {canGrant ? (
              <div className="settings-actions">
                {needsName ? (
                  <>
                    <label htmlFor={`connector-secret-${row.id}`}>{t('settingsEntries.connectors.vaultName')}</label>
                    {secrets.length > 0 ? (
                      <select
                        id={`connector-secret-${row.id}`}
                        value={selected}
                        disabled={busyId === row.id}
                        onChange={(event) => onPick(row.id, event.target.value)}
                      >
                        {secrets.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`connector-secret-${row.id}`}
                        value={selected}
                        disabled={busyId === row.id}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => onPick(row.id, event.target.value)}
                      />
                    )}
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-grant={row.id}
                  disabled={busyId === row.id || (needsName && !selected)}
                  onClick={() => onGrant(row)}
                >
                  {t('settingsEntries.connectors.grant')}
                </button>
              </div>
            ) : (
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busyId === row.id}
                  onClick={() => onRevoke(row)}
                >
                  {t('settingsEntries.connectors.revoke')}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {rowError ? (
        <p role="alert" className="settings-field__error">
          {rowError}
        </p>
      ) : null}
      <div className="settings-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          {t('settingsEntries.common.refresh')}
        </button>
      </div>
    </>
  );
}

export function ConnectorsSettingsCard() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ConnectorView[] | null>(null);
  const [secrets, setSecrets] = useState<SecretName[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const data = (await api('/api/connectors')) as { connectors?: unknown };
      let names: SecretName[] = [];
      try {
        names = secretNames((await api('/api/secrets')) as { secrets?: unknown });
      } catch {
        names = [];
      }
      setSecrets(names);
      setRows(connectorViews(data));
    } catch {
      setRows(null);
      setError(t('settingsEntries.connectors.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grant = async (row: ConnectorView) => {
    const name = picks[row.id] ?? defaultGrantName(row, secrets);
    setRowError(null);
    setBusyId(row.id);
    try {
      await postConnectorGrant(row, name);
      await reload();
    } catch {
      setRowError(t('settingsEntries.connectors.grantFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (row: ConnectorView) => {
    setRowError(null);
    setBusyId(row.id);
    try {
      await api(`/api/connectors/${encodeURIComponent(row.id)}/revoke`, { method: 'POST' });
      await reload();
    } catch {
      setRowError(t('settingsEntries.connectors.revokeFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="settings-stack" id="card-connectors">
      <SettingsGroup title={t('settingsEntries.connectors.title')} description={t('settingsEntries.connectors.desc')}>
        <LoadGate ready={rows !== null} error={error} onRetry={() => void reload()}>
          {rows ? (
            <ConnectorAuthList
              rows={rows}
              secrets={secrets}
              picks={picks}
              busyId={busyId}
              rowError={rowError}
              onPick={(id, name) => setPicks((prev) => ({ ...prev, [id]: name }))}
              onGrant={(row) => void grant(row)}
              onRevoke={(row) => void revoke(row)}
              onRefresh={() => void reload()}
            />
          ) : null}
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}
