import {
  parseMachineList,
  parseMachine,
  applyRegister,
  applyUnregister,
  applyRefresh,
  type RegisteredMachineSummary
} from './registered-machines-model.ts';

export type ApiFn = (path: string, init?: RequestInit) => Promise<unknown>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadMachines(api: ApiFn): Promise<{ machines: RegisteredMachineSummary[] } | { error: string }> {
  try {
    return { machines: parseMachineList(await api('/api/registered-machines')) };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function registerMachine(
  api: ApiFn,
  input: { machineId: string; label: string; kind: string }
): Promise<{ machine: RegisteredMachineSummary } | { error: string }> {
  try {
    const machine = parseMachine(
      await api('/api/registered-machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
    );
    if (!machine) return { error: 'invalid machine' };
    return { machine };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function unregisterMachine(
  api: ApiFn,
  machineId: string
): Promise<{ ok: true } | { error: string }> {
  try {
    await api(`/api/registered-machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function refreshMachine(
  api: ApiFn,
  machineId: string
): Promise<{ machine: RegisteredMachineSummary } | { error: string }> {
  try {
    const machine = parseMachine(
      await api(`/api/registered-machines/${encodeURIComponent(machineId)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
    );
    if (!machine) return { error: 'invalid machine' };
    return { machine };
  } catch (e) {
    return { error: errText(e) };
  }
}

export { applyRegister, applyUnregister, applyRefresh };
