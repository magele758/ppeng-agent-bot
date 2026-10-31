'use client';

import { useCallback, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { useRegisteredMachines } from './machines/use-registered-machines.ts';

function getAttachHint(kind: string): string {
  if (kind === 'desktop') {
    return 'GET /api/desktop-agent/:id/events (SSE)';
  }
  if (kind === 'phone') {
    return 'GET /api/device-local/:id/events (SSE)';
  }
  return 'SSH only';
}

export function RegisteredMachinesPanel() {
  const t = useI18n().t;
  const label = (key: string) => t(`settingsEntries.registeredMachines.${key}` as MessageKey);
  const { machines, busy, err, msg, setErr, setMsg, load, register, unregister, refresh } = useRegisteredMachines();

  const [machineId, setMachineId] = useState('');
  const [macLabel, setMacLabel] = useState('');
  const [kind, setKind] = useState('desktop');

  const handleRegister = useCallback(async () => {
    if (!machineId.trim() || !macLabel.trim()) {
      setErr(t('settingsEntries.registeredMachines.error.required' as MessageKey));
      return;
    }
    await register({ machineId: machineId.trim(), label: macLabel.trim(), kind });
    setMachineId('');
    setMacLabel('');
    setKind('desktop');
  }, [machineId, macLabel, kind, register, setErr, t]);

  return (
    <SettingsGroup title={label('title')} description={label('description')}>
      {err && <div style={{ color: '#d9534f', marginBottom: '1em' }}>{err}</div>}
      {msg && <div style={{ color: '#5cb85c', marginBottom: '1em' }}>{msg}</div>}

      <div style={{ marginBottom: '2em' }}>
        <h3>{label('registerNew')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5em', marginBottom: '1em' }}>
          <input
            type="text"
            placeholder={label('machineIdPlaceholder')}
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
            disabled={busy}
            style={{ padding: '0.5em', border: '1px solid #ccc', borderRadius: '4px' }}
          />
          <input
            type="text"
            placeholder={label('labelPlaceholder')}
            value={macLabel}
            onChange={(e) => setMacLabel(e.target.value)}
            disabled={busy}
            style={{ padding: '0.5em', border: '1px solid #ccc', borderRadius: '4px' }}
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            disabled={busy}
            style={{ padding: '0.5em', border: '1px solid #ccc', borderRadius: '4px' }}
          >
            <option value="desktop">{label('kindDesktop')}</option>
            <option value="phone">{label('kindPhone')}</option>
            <option value="other">{label('kindOther')}</option>
          </select>
          <button onClick={handleRegister} disabled={busy} style={{ padding: '0.5em', cursor: busy ? 'not-allowed' : 'pointer' }}>
            {busy ? label('registering') : label('register')}
          </button>
        </div>
      </div>

      <div>
        <h3>{label('listTitle')}</h3>
        {machines.length === 0 ? (
          <p>{label('noMachines')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1em' }}>
            {machines.map((machine) => (
              <div
                key={machine.machineId}
                style={{
                  padding: '1em',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <div>
                  <strong>{machine.label}</strong> ({machine.machineId})
                  <div style={{ fontSize: '0.9em', color: '#666' }}>
                    Kind: {machine.kind} • Status: {machine.connected ? '🟢 Connected' : '⚪ Disconnected'}
                  </div>
                  <div style={{ fontSize: '0.85em', color: '#999', marginTop: '0.5em' }}>
                    {label('attachHint')}: {getAttachHint(machine.kind)}
                  </div>
                  {machine.sshAlias && (
                    <div style={{ fontSize: '0.85em', color: '#999' }}>SSH: {machine.sshAlias}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5em' }}>
                  <button
                    onClick={() => refresh(machine.machineId)}
                    disabled={busy}
                    style={{ padding: '0.4em 0.8em', cursor: busy ? 'not-allowed' : 'pointer' }}
                  >
                    {label('refresh')}
                  </button>
                  <button
                    onClick={() => unregister(machine.machineId)}
                    disabled={busy}
                    style={{ padding: '0.4em 0.8em', cursor: busy ? 'not-allowed' : 'pointer', color: '#d9534f' }}
                  >
                    {label('unregister')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!machines.length && (
          <button onClick={load} disabled={busy} style={{ padding: '0.5em', cursor: busy ? 'not-allowed' : 'pointer' }}>
            {label('refresh')}
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}
