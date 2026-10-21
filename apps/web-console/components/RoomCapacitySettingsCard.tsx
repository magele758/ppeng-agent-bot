'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from './ui';

interface RoomSettings {
  rosterCap: number;
  maxRoomMembers: number;
  maxWaveSpeakers: number;
}

export function RoomCapacitySettingsCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/api/bot-rooms/settings')
      .then(data => setSettings((data as { settings: RoomSettings }).settings))
      .catch(error => setStatus(error instanceof Error ? error.message : t('settings.roomCapacity.saveFailed')));
  }, [t]);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setStatus('');
    try {
      const data = (await api('/api/bot-rooms/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })) as { settings: RoomSettings };
      setSettings(data.settings);
      setStatus(t('settings.roomCapacity.saved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('settings.roomCapacity.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" id="card-room-capacity">
      <SettingsGroup title={t('settings.entries.roomCapacity.title')} description={t('settings.roomCapacity.description')}>
        <label>
          {t('settings.roomCapacity.rosterCap')}
          <input data-testid="room-capacity-roster" type="number" min={1} max={500} value={settings?.rosterCap ?? ''} disabled={!settings || busy} onChange={event => setSettings(current => current ? { ...current, rosterCap: Number(event.target.value) } : current)} />
        </label>
        <label>
          {t('settings.roomCapacity.maxRoomMembers')}
          <input data-testid="room-capacity-members" type="number" min={2} max={200} value={settings?.maxRoomMembers ?? ''} disabled={!settings || busy} onChange={event => setSettings(current => current ? { ...current, maxRoomMembers: Number(event.target.value) } : current)} />
        </label>
        <label>
          {t('settings.roomCapacity.maxWaveSpeakers')}
          <input data-testid="room-capacity-wave" type="number" min={1} max={10} value={settings?.maxWaveSpeakers ?? ''} disabled={!settings || busy} onChange={event => setSettings(current => current ? { ...current, maxWaveSpeakers: Number(event.target.value) } : current)} />
        </label>
        <button type="button" data-testid="room-capacity-save" disabled={!settings || busy} onClick={() => void save()}>{t('settings.roomCapacity.save')}</button>
        {status ? <p>{status}</p> : null}
      </SettingsGroup>
    </div>
  );
}
