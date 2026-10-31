'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { RegisteredMachineSummary } from './registered-machines-model.ts';
import {
  applyRefresh,
  applyRegister,
  applyUnregister,
  loadMachines,
  refreshMachine,
  registerMachine,
  unregisterMachine
} from './registered-machines-actions.ts';

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useRegisteredMachines() {
  const t = useI18n();
  const [machines, setMachines] = useState<RegisteredMachineSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const result = await loadMachines(api);
    if ('machines' in result) {
      setMachines(result.machines);
      setLoaded(true);
    } else {
      setErr(result.error);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const register = useCallback(
    async (input: { machineId: string; label: string; kind: string }) => {
      setBusy(true);
      setErr(null);
      setMsg(null);
      const result = await registerMachine(api, input);
      if ('machine' in result) {
        setMachines(applyRegister(machines, result.machine));
        setMsg(t('settingsEntries.registeredMachines.registered'));
      } else {
        setErr(result.error);
      }
      setBusy(false);
    },
    [machines, t]
  );

  const unregister = useCallback(
    async (machineId: string) => {
      setBusy(true);
      setErr(null);
      setMsg(null);
      const result = await unregisterMachine(api, machineId);
      if ('ok' in result) {
        setMachines(applyUnregister(machines, machineId));
        setMsg(t('settingsEntries.registeredMachines.unregistered'));
      } else {
        setErr(result.error);
      }
      setBusy(false);
    },
    [machines, t]
  );

  const refresh = useCallback(
    async (machineId: string) => {
      setBusy(true);
      setErr(null);
      const result = await refreshMachine(api, machineId);
      if ('machine' in result) {
        setMachines(applyRefresh(machines, result.machine));
      } else {
        setErr(result.error);
      }
      setBusy(false);
    },
    [machines]
  );

  return { machines, loaded, busy, err, msg, setErr, setMsg, load, register, unregister, refresh };
}
